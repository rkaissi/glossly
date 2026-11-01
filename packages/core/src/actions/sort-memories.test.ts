import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LlmError, type ChatRequest, type LlmProvider } from '../llm/types';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { formatSortPrompt, sortMemories } from './sort-memories';

let store: Store;
afterEach(() => store?.close());

function fakeLlm(answer: (req: ChatRequest) => unknown): LlmProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    stream: () => {
      throw new Error('unused');
    },
    structured: async <T>(req: ChatRequest, schema: z.ZodType<T>) => {
      calls.push(req);
      return schema.parse(answer(req));
    },
    hasModel: () => true,
  };
}

function setup(answer: (req: ChatRequest) => unknown) {
  store = new Store(':memory:');
  const people = new PeopleRepo(store);
  const casey = people.create({ name: 'Casey Lin' });
  let about: { id: string; text: string; at: string }[] = [{ id: 'a0', text: 'Works at Acme', at: '2026-10-01' }];
  let n = 0;
  const memory = (text: string) => store.insertItem({ collection_id: null, kind: 'note', text, why: null, source_app: null, window_title: null, data_json: null }).id;
  const llm = fakeLlm(answer);
  const deps = {
    llm,
    store,
    people,
    userName: 'Alex Morgan',
    aboutMe: () => about,
    setAboutMe: (next: typeof about) => {
      about = next;
    },
    newId: () => `id${++n}`,
    now: () => '2026-11-01T09:00:00-04:00',
  };
  return { deps, people, casey, memory, llm, about: () => about };
}

describe('sortMemories (decision 84)', () => {
  it('moves facts about the user and saved people, and keeps the rest as memories', async () => {
    // The fake model answers from the prompt's lines ("m2: Casey Lin is vegetarian"), whatever their order.
    const answers: Record<string, { about: string; person: string | null; fact: string | null } | undefined> = {
      'Alex lives in Lisbon': { about: 'user', person: null, fact: 'Lives in Lisbon' },
      'Casey Lin is vegetarian': { about: 'person', person: 'Casey Lin', fact: 'Casey Lin is vegetarian' },
      "Northwind's fiscal year starts in April": { about: 'none', person: null, fact: null },
      'Jordan Hale leads pricing': { about: 'person', person: 'Jordan Hale', fact: 'Jordan Hale leads pricing' },
    };
    const { deps, people, casey, memory, llm, about } = setup((req) => ({
      items: [
        ...[...req.prompt.matchAll(/^(m\d+): (.+)$/gm)].flatMap(([, id, text]) => {
          const a = answers[text!];
          return a ? [{ id: id!, ...a }] : [];
        }),
        { id: 'm99', about: 'user', person: null, fact: 'Invented id' },
      ],
    }));
    const lisbon = memory('Alex lives in Lisbon');
    const veg = memory('Casey Lin is vegetarian');
    const fiscal = memory("Northwind's fiscal year starts in April");
    const jordan = memory('Jordan Hale leads pricing');
    const untouched = memory('Lunch place on 5th is good');

    const r = await sortMemories(deps);
    expect(r).toEqual({ seen: 5, toUser: 1, toPeople: 1, kept: 3 });
    expect(about().map((f) => f.text)).toEqual(['Works at Acme', 'Lives in Lisbon']);
    expect(people.facts(casey.id).map((f) => [f.text, f.source])).toEqual([['Casey Lin is vegetarian', 'ask']]);
    expect(store.getItem(lisbon)).toBeNull();
    expect(store.getItem(veg)).toBeNull();
    // Someone not saved, something about no one, and a memory the model skipped stay where they were.
    for (const id of [fiscal, jordan, untouched]) expect(store.getItem(id)).not.toBeNull();
    expect(llm.calls[0]).toMatchObject({ role: 'fast', action: 'sort_memories', temperature: 0 });
  });

  it('makes no call with no memories, and leaves everything in place when the call fails', async () => {
    const empty = setup(() => ({ items: [] }));
    expect(await sortMemories(empty.deps)).toEqual({ seen: 0, toUser: 0, toPeople: 0, kept: 0 });
    expect(empty.llm.calls).toHaveLength(0);
    store.close();

    const failing = setup(() => {
      throw new LlmError('provider', 'Slow down');
    });
    const id = failing.memory('Casey Lin is vegetarian');
    await expect(sortMemories(failing.deps)).rejects.toThrow('Slow down');
    expect(store.getItem(id)).not.toBeNull();
  });

  it('lists the user, the saved people, and the memories with short ids', () => {
    const p = formatSortPrompt('Alex Morgan', ['Casey Lin'], [{ id: 'm1', text: '  Casey Lin\n is vegetarian ' }]);
    expect(p).toContain('The user: Alex Morgan');
    expect(p).toContain('Saved people: Casey Lin');
    expect(p).toContain('m1: Casey Lin is vegetarian');
  });
});
