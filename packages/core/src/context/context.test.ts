import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../embed/types';
import { CalendarRepo } from '../store/calendar';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { isoNow } from '../types';
import { contextDocs, eventDoc, personDoc, taskDoc } from './docs';
import { ContextSyncer, syncContext } from './sync';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

const DIMS = 4;
const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));

/** Lunch-ish text points one way, everything else another; counts what it embedded. */
function fakeEmbedder() {
  const seen: string[] = [];
  const embedder: Embedder = {
    model: 'fake',
    dims: DIMS,
    embed: async (texts) => {
      seen.push(...texts);
      return texts.map((t) => {
        const v = new Float32Array(DIMS);
        v[/lunch/i.test(t) ? 0 : 1] = 1;
        return v;
      });
    },
  };
  return { embedder, seen };
}

function setup(withVectors = true) {
  store = new Store(':memory:', withVectors ? { vecExtensionPath } : {});
  store.ensureVectorModel('fake', DIMS);
  const people = new PeopleRepo(store, () => at(14, 10));
  const calendar = new CalendarRepo(store);
  const { embedder, seen } = fakeEmbedder();
  return { store, people, calendar, seen, deps: { store, people, calendar, embedder: () => embedder } };
}

describe('context docs', () => {
  it('reads a person by their names, relationship, note, and recent messages, without emails or handles', () => {
    const doc = personDoc(
      {
        id: 'p1',
        name: 'Jordan Hale',
        note: 'Runs   the design team at Acme.',
        relationship: 'colleague',
        aliases: [
          { kind: 'name', value: 'Jordan Hale' },
          { kind: 'name', value: 'Jo' },
          { kind: 'email', value: 'jordan@example.com' },
          { kind: 'handle', value: 'jhale' },
        ],
      },
      [
        { direction: 'inbound', text: 'Can we move the review?' },
        { direction: 'outbound', text: 'Sure, Friday works.' },
      ],
    );
    expect(doc).toEqual({
      id: 'p1',
      kind: 'person',
      text: 'Jordan Hale (also Jo)\nRelationship: colleague\nNote: Runs the design team at Acme.\nThey wrote: Can we move the review?\nThe user wrote: Sure, Friday works.',
    });
  });

  it('reads a task by who owes whom and when, leaving its status out', () => {
    const base = { id: 't1', text: 'Send the deck', due_at: '2026-10-16', person_name: 'Casey Lin' };
    expect(taskDoc({ ...base, owner: 'me' }).text).toBe('Task: Send the deck\nThe user owes Casey Lin\nDue Friday, Oct 16');
    expect(taskDoc({ ...base, owner: 'them' }).text).toBe('Task: Send the deck\nCasey Lin owes the user\nDue Friday, Oct 16');
    expect(taskDoc({ ...base, owner: 'me', person_name: null, due_at: null }).text).toBe("Task: Send the deck\nThe user's own task");
  });

  it('reads an event by title, time, place, and attendees', () => {
    const e = { id: 'e1', title: 'Lunch with Jordan', starts_at: at(15, 13), ends_at: at(15, 14), all_day: false, location: 'Northwind Cafe', attendees: ['Jordan Hale'] };
    expect(eventDoc(e).text).toBe('Event: Lunch with Jordan\nThursday, Oct 15, 1:00 PM to 2:00 PM\nAt Northwind Cafe\nWith Jordan Hale');
    expect(eventDoc({ ...e, ends_at: at(16, 9) }).text).toContain('Thursday, Oct 15, 1:00 PM to Friday, Oct 16, 9:00 AM');
    expect(eventDoc({ ...e, starts_at: '2026-10-15', ends_at: null, all_day: true, location: null, attendees: [] }).text).toBe('Event: Lunch with Jordan\nAll day Thursday, Oct 15');
  });

  it('covers every person, task, and event, done tasks included', () => {
    const { people, calendar } = setup(false);
    const p = people.create({ name: 'Casey Lin' });
    const t = people.addCommitment({ person_id: p.id, owner: 'me', text: 'Send the deck', due_at: null });
    people.setCommitmentStatus(t.id, 'done');
    calendar.add({ title: 'Lunch', starts_at: at(15, 12), ends_at: null, all_day: false, location: null, attendees: [], personIds: [] }, null);
    expect(contextDocs(people, calendar).map((d) => d.kind)).toEqual(['person', 'task', 'event']);
  });
});

describe('syncContext', () => {
  it('embeds every row once, then only what changed, and drops what was deleted', async () => {
    const { store, people, calendar, seen, deps } = setup();
    const p = people.create({ name: 'Jordan Hale' });
    const t = people.addCommitment({ person_id: p.id, owner: 'them', text: 'Book the lunch spot', due_at: null });
    const e = calendar.add({ title: 'Lunch with Jordan', starts_at: at(15, 13), ends_at: null, all_day: false, location: null, attendees: [], personIds: [p.id] }, null);

    expect(await syncContext(deps)).toEqual({ embedded: 3, removed: 0 });
    expect(await syncContext(deps)).toEqual({ embedded: 0, removed: 0 });

    // Ticking a task off changes nothing that is embedded; a new note on the person does.
    people.setCommitmentStatus(t.id, 'done');
    people.update(p.id, { note: 'Met at the Acme offsite.' });
    seen.length = 0;
    expect(await syncContext(deps)).toEqual({ embedded: 1, removed: 0 });
    expect(seen[0]).toContain('Met at the Acme offsite.');

    calendar.delete(e.id);
    expect(await syncContext(deps)).toEqual({ embedded: 0, removed: 1 });
    expect(store.contextHashes().has(e.id)).toBe(false);
    expect(store.searchContextVectors(new Float32Array([1, 0, 0, 0]), 'event')).toEqual([]);
  });

  it('searches inside one kind', async () => {
    const { store, people, calendar, deps } = setup();
    const p = people.create({ name: 'Jordan Hale' });
    const t = people.addCommitment({ person_id: p.id, owner: 'me', text: 'Pick a lunch place', due_at: null });
    const e = calendar.add({ title: 'Lunch with Jordan', starts_at: at(15, 13), ends_at: null, all_day: false, location: null, attendees: [], personIds: [] }, null);
    await syncContext(deps);
    const lunch = new Float32Array([1, 0, 0, 0]);
    expect(store.searchContextVectors(lunch, 'event', 5)).toEqual([{ doc_id: e.id, similarity: expect.closeTo(1, 5) }]);
    expect(store.searchContextVectors(lunch, 'task', 5).map((r) => r.doc_id)).toEqual([t.id]);
    expect(store.searchContextVectors(lunch, 'person', 5)).toEqual([{ doc_id: p.id, similarity: expect.closeTo(0, 5) }]);
  });

  it('does nothing without vectors or before the embedder is ready', async () => {
    const off = setup(false);
    off.people.create({ name: 'Jordan Hale' });
    expect(await syncContext(off.deps)).toBeNull();
    off.store.close();
    const on = setup();
    on.people.create({ name: 'Jordan Hale' });
    expect(await syncContext({ ...on.deps, embedder: () => null })).toBeNull();
  });

  it('starts over when the embedding model changes, and Delete all data clears it', async () => {
    const { store, people, deps } = setup();
    people.create({ name: 'Jordan Hale' });
    await syncContext(deps);
    expect(store.ensureVectorModel('other', DIMS)).toBe(true);
    expect(store.contextHashes().size).toBe(0);
    expect(await syncContext(deps)).toEqual({ embedded: 1, removed: 0 });
    store.deleteAll();
    expect(store.contextHashes().size).toBe(0);
    expect(store.searchContextVectors(new Float32Array([0, 1, 0, 0]), 'person')).toEqual([]);
  });

  it('adds the context table to a database that has item vectors from before migration 10', () => {
    const { store } = setup();
    store.db.exec('DROP TABLE context_vectors');
    expect(store.ensureVectorModel('fake', DIMS)).toBe(false);
    expect(store.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'context_vectors'").get()).toEqual({ ok: 1 });
  });
});

describe('ContextSyncer', () => {
  it('runs once more after a running sync for calls that came in meanwhile, and shares that run', async () => {
    const { people, deps } = setup();
    people.create({ name: 'Jordan Hale' });
    const syncer = new ContextSyncer(deps);
    const first = syncer.sync();
    people.create({ name: 'Casey Lin' });
    const second = syncer.sync();
    const third = syncer.sync();
    expect(second).toBe(third);
    const results = await Promise.all([first, second]);
    expect(results.reduce((n, r) => n + (r?.embedded ?? 0), 0)).toBe(2);
  });
});
