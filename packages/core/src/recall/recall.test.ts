import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../embed/types';
import { DEFAULT_SETTINGS } from '../settings';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { containsTerm, recall, search } from './recall';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

const DIMS = 5;
/** A toy embedder: one axis per topic word (the last axis is "none of them"), so similarity is easy to predict. */
const TOPICS = ['budget', 'launch', 'recipe', 'travel'];
const fakeEmbedder: Embedder = {
  model: 'fake',
  dims: DIMS,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(DIMS);
      TOPICS.forEach((w, i) => {
        if (t.toLowerCase().includes(w)) v[i] = 1;
      });
      if (!v.some(Boolean)) v[DIMS - 1] = 1;
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  },
};

let store: Store;
afterEach(() => store?.close());

function setup(withEmbedder = true) {
  store = new Store(':memory:', { vecExtensionPath });
  store.ensureVectorModel('fake', DIMS);
  const notes = store.collectionByName('Notes')!;
  const save = async (text: string, created_at: string, entities: [Parameters<Store['upsertEntity']>[0], string][] = []) => {
    const item = store.insertItem({ collection_id: notes.id, kind: 'selection', text, why: null, source_app: 'chrome.exe', window_title: 'Docs', data_json: null, created_at });
    for (const [kind, name] of entities) store.linkItemEntity(item.id, store.upsertEntity(kind, name));
    const [v] = await fakeEmbedder.embed([text]);
    store.setVector(item.id, v!);
    return item;
  };
  const deps = {
    store,
    embedder: () => (withEmbedder ? fakeEmbedder : null),
    settings: () => ({ recall: DEFAULT_SETTINGS.recall }),
  };
  return { save, deps };
}

describe('containsTerm', () => {
  it('matches whole words only, and nothing under 3 characters', () => {
    expect(containsTerm('lunch with maya chen on friday', 'maya chen')).toBe(true);
    expect(containsTerm('mayan ruins', 'maya')).toBe(false);
    expect(containsTerm('ai is here', 'ai')).toBe(false);
  });
});

describe('recall', () => {
  it('ranks a shared person ahead of a similar topic, and caps the list', async () => {
    const { save, deps } = setup();
    const person = await save('Coffee notes from Tuesday', '2026-10-01T10:00:00-04:00', [['person', 'Maya Chen']]);
    const place = await save('The offsite is in Lisbon', '2026-10-02T10:00:00-04:00', [['place', 'Lisbon']]);
    const topic = await save('Q4 budget draft is attached', '2026-10-03T10:00:00-04:00');
    await save('A soup recipe', '2026-10-04T10:00:00-04:00');

    const hits = await recall(deps, { text: 'Maya Chen asked about the budget for Lisbon' });
    expect(hits.map((h) => h.itemId)).toEqual([person.id, place.id, topic.id]);
    expect(hits.map((h) => h.reason)).toEqual(['same_person', 'same_place', 'similar_topic']);
    expect(hits[0]?.term).toBe('Maya Chen');
    expect(hits[2]?.similarity).toBeGreaterThanOrEqual(0.78);

    const capped = await recall({ ...deps, settings: () => ({ recall: { ...DEFAULT_SETTINGS.recall, maxResults: 1 } }) }, { text: 'Maya Chen and the budget' });
    expect(capped).toHaveLength(1);
  });

  it('shows nothing for unrelated text, and leaves out the item saved from this very selection', async () => {
    const { save, deps } = setup();
    await save('Q4 budget draft is attached', '2026-10-03T10:00:00-04:00');
    expect(await recall(deps, { text: 'Weekend travel plans' })).toEqual([]);
    expect(await recall(deps, { text: 'Q4 budget draft is attached' })).toEqual([]);
  });

  it('matches a known person found by alias, and works without the embedding model', async () => {
    const { save, deps } = setup(false);
    const item = await save('Sam owes us the deck', '2026-10-01T10:00:00-04:00', [['person', 'Sam Okonkwo']]);
    const people = new PeopleRepo(store);
    const sam = people.create({ name: 'Sam Okonkwo', aliases: [{ kind: 'email', value: 'sam@example.com' }] });
    store.setPersonEntity(sam.id, store.upsertEntity('person', 'Sam Okonkwo'));
    const hits = await recall(deps, { text: 'Reply to sam@example.com today', personIds: [sam.id] });
    expect(hits.map((h) => [h.itemId, h.reason])).toEqual([[item.id, 'same_person']]);
  });
});

describe('search', () => {
  it('finds saved items by words, then by meaning, plus people and open commitments', async () => {
    const { save, deps } = setup();
    const words = await save('The launch moved to Thursday', '2026-10-01T10:00:00-04:00');
    const meaning = await save('Launch checklist', '2026-10-02T10:00:00-04:00');
    const people = new PeopleRepo(store);
    const lena = people.create({ name: 'Lena Ortiz' });
    people.addCommitment({ person_id: lena.id, owner: 'me', text: 'Send Lena the launch slides', due_at: null });

    const r = await search({ ...deps, people }, 'moved to Thursday');
    expect(r.items.map((h) => [h.itemId, h.reason])).toEqual([[words.id, 'text_match']]);

    const byMeaning = await search({ ...deps, people }, 'launch');
    expect(byMeaning.items.map((h) => h.itemId).sort()).toEqual([words.id, meaning.id].sort());
    expect(byMeaning.commitments.map((c) => c.text)).toEqual(['Send Lena the launch slides']);

    const person = await search({ ...deps, people }, 'lena');
    expect(person.people.map((p) => p.name)).toEqual(['Lena Ortiz']);
    expect(person.commitments).toHaveLength(1);

    const empty = await search({ ...deps, people }, '  ');
    expect(empty.items.map((h) => h.itemId)).toEqual([meaning.id, words.id]);
    expect(empty.semantic).toBe(true);
  });

  it('treats % and _ as plain characters', async () => {
    const { save, deps } = setup(false);
    await save('Growth was 40% last quarter', '2026-10-01T10:00:00-04:00');
    await save('Growth was 40 last quarter', '2026-10-02T10:00:00-04:00');
    const r = await search({ ...deps, people: new PeopleRepo(store) }, '40%');
    expect(r.items).toHaveLength(1);
    expect(r.semantic).toBe(false);
  });
});
