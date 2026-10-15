import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../embed/types';
import { DEFAULT_SETTINGS } from '../settings';
import { CalendarRepo } from '../store/calendar';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { isoNow } from '../types';
import { namedDays } from './days';
import { linkNamedPeople, namedPeople, retrieveContext } from './retrieve';
import { syncContext } from './sync';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

// Wednesday, Oct 14 2026, 10 am.
const NOW = new Date(2026, 9, 14, 10);
const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));

describe('namedDays', () => {
  const days = (t: string) => namedDays(t, NOW);
  it('reads the days a message names', () => {
    expect(days('are you free Thursday?')).toEqual(['2026-10-15']);
    expect(days('Can we do tomorrow or next Friday instead')).toEqual(['2026-10-15', '2026-10-23']);
    expect(days('how about tonight')).toEqual(['2026-10-14']);
    expect(days('Lunch on Oct 20? or 10/22')).toEqual(['2026-10-20', '2026-10-22']);
    expect(days('the 19th works')).toEqual(['2026-10-19']);
    expect(days('free this weekend?')).toEqual(['2026-10-17', '2026-10-18']);
    expect(days('next weekend then')).toEqual(['2026-10-24', '2026-10-25']);
    expect(days('see you thurs')).toEqual(['2026-10-15']);
  });

  it('finds nothing in text without a day', () => {
    expect(days('Thanks for the notes, they help a lot')).toEqual([]);
    expect(days('I may 3x the budget')).toEqual([]);
  });
});

/**
 * Words map to fixed directions, so "lunch" texts are close to each other; any other text gets
 * a direction of its own, far from everything else.
 */
const TOPICS = ['lunch', 'dentist', 'deck', 'flight'];
const DIMS = 64;
const own = (t: string) => TOPICS.length + ([...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % (DIMS - TOPICS.length));
const embedder: Embedder = {
  model: 'fake',
  dims: DIMS,
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Float32Array(DIMS);
      const i = TOPICS.findIndex((w) => t.toLowerCase().includes(w));
      v[i < 0 ? own(t) : i] = 1;
      return v;
    }),
};

function setup() {
  store = new Store(':memory:', { vecExtensionPath });
  store.ensureVectorModel('fake', embedder.dims);
  const people = new PeopleRepo(store, () => at(14, 10));
  const calendar = new CalendarRepo(store);
  const deps = {
    store,
    people,
    calendar,
    embedder: () => embedder,
    settings: () => ({ recall: DEFAULT_SETTINGS.recall, context: DEFAULT_SETTINGS.context }),
    sync: () => syncContext({ store: store!, embedder: () => embedder }),
  };
  const event = (title: string, starts_at: string, personIds: string[] = []) =>
    calendar.add({ title, starts_at, ends_at: null, all_day: starts_at.length === 10, location: null, attendees: [], personIds }, null);
  return { store, people, calendar, deps, event };
}

describe('retrieveContext', () => {
  it("brings the named day's events for \"are you free Thursday?\", whoever they are with", async () => {
    const { people, deps, event } = setup();
    const jordan = people.create({ name: 'Jordan Hale' });
    const casey = people.create({ name: 'Casey Lin', relationship: 'friend' });
    const meeting = event('Meeting with Casey', at(15, 13), [casey.id]);
    event('Team sync', at(16, 9));
    const r = await retrieveContext(deps, { texts: ['are you free Thursday?'], personIds: [jordan.id], now: NOW });
    expect(r.days).toEqual(['2026-10-15']);
    expect(r.events.map((e) => [e.id, e.reason])).toEqual([[meeting.id, 'day']]);
    expect(r.people.map((p) => [p.name, p.reason])).toEqual([['Jordan Hale', 'given']]);
  });

  it('finds people by name, their open tasks and coming events, then the rest by meaning', async () => {
    const { people, deps, event } = setup();
    const jordan = people.create({ name: 'Jordan Hale', note: 'Design lead at Acme' });
    const dentist = people.create({ name: 'Dr. Maya Chen', note: 'My dentist' });
    const owed = people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'Send the deck', due_at: null });
    const done = people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'Book a room', due_at: null });
    people.setCommitmentStatus(done.id, 'done');
    const withJordan = event('Review with Jordan', at(20, 15), [jordan.id]);
    event('Old review with Jordan', at(1, 15), [jordan.id]);
    const checkup = event('Dentist checkup', at(28, 9));

    const r = await retrieveContext(deps, { texts: ['Jordan Hale asked about the dentist appointment'], now: NOW });
    expect(r.people.map((p) => [p.id, p.reason])).toEqual([
      [jordan.id, 'named'],
      [dentist.id, 'similar'],
    ]);
    // The done task was finished just now, so it stays too (by meaning it isn't close).
    expect(r.tasks.map((t) => [t.id, t.reason])).toEqual([[owed.id, 'person']]);
    // A week back to 60 days ahead: the Oct 1 review is too old.
    expect(r.events.map((e) => [e.id, e.reason])).toEqual([
      [withJordan.id, 'person'],
      [checkup.id, 'similar'],
    ]);
    expect(r.semantic).toBe(true);
  });

  it('keeps tasks finished in the last week and drops older ones', async () => {
    const { people, store, deps } = setup();
    const recent = people.addCommitment({ person_id: null, owner: 'me', text: 'Practice the deck', due_at: null });
    const old = people.addCommitment({ person_id: null, owner: 'me', text: 'Print the deck', due_at: null });
    people.setCommitmentStatus(recent.id, 'done');
    people.setCommitmentStatus(old.id, 'done');
    store.db.prepare('UPDATE commitments SET completed_at = ? WHERE id = ?').run(at(1, 9), old.id);
    const r = await retrieveContext(deps, { texts: ['did I get the deck ready?'], now: NOW });
    expect(r.tasks.map((t) => [t.id, t.status, t.reason])).toEqual([[recent.id, 'done', 'similar']]);
  });

  it('brings tasks due on a named day', async () => {
    const { people, deps } = setup();
    const due = people.addCommitment({ person_id: null, owner: 'me', text: 'Renew passport', due_at: '2026-10-15' });
    people.addCommitment({ person_id: null, owner: 'me', text: 'Water plants', due_at: '2026-10-16' });
    const r = await retrieveContext(deps, { texts: ['what do I have tomorrow'], now: NOW });
    expect(r.tasks.map((t) => [t.id, t.reason])).toEqual([[due.id, 'day']]);
  });

  it('brings saved notes through Recall and caps each kind', async () => {
    const { store, people, deps, event } = setup();
    const notes = store.collectionByName('Notes')!;
    const item = store.insertItem({ collection_id: notes.id, kind: 'note', text: 'Northwind Cafe does the best lunch', why: null, source_app: null, window_title: null, data_json: null });
    store.setVector(item.id, (await embedder.embed([item.text]))[0]!);
    for (let d = 15; d < 25; d++) event(`Lunch ${d}`, at(d, 12));
    for (let i = 0; i < 5; i++) people.create({ name: `Lunch friend ${i}` });
    const r = await retrieveContext({ ...deps, settings: () => ({ recall: DEFAULT_SETTINGS.recall, context: { ...DEFAULT_SETTINGS.context, maxEvents: 2, maxPeople: 1 } }) }, { texts: ['where should we get lunch?'], now: NOW });
    expect(r.notes.map((n) => n.itemId)).toEqual([item.id]);
    expect(r.events).toHaveLength(2);
    expect(r.people).toHaveLength(1);
  });

  it('uses exact matches and named days alone without the embedder', async () => {
    const { people, deps, event } = setup();
    const jordan = people.create({ name: 'Jordan Hale' });
    const e = event('Dentist', at(15, 9));
    const r = await retrieveContext({ ...deps, embedder: () => null, sync: undefined }, { texts: ['Jordan Hale: free Thursday for the dentist?'], now: NOW });
    expect(r.semantic).toBe(false);
    expect(r.people.map((p) => p.id)).toEqual([jordan.id]);
    expect(r.events.map((x) => x.id)).toEqual([e.id]);
  });
});

describe('linkNamedPeople', () => {
  it("links a memory to the people it names by full name, so it's on their card", () => {
    const { store, people } = setup();
    const casey = people.create({ name: 'Casey Lin' });
    const jordan = people.create({ name: 'Jordan Hale' });
    const notes = store.collectionByName('Notes')!;
    const item = store.insertItem({ collection_id: notes.id, kind: 'note', text: 'Casey Lin is vegetarian; Jordan knows', why: null, source_app: null, window_title: null, data_json: null });
    expect(linkNamedPeople(store, people, item.id, item.text)).toEqual([casey.id]);
    expect(people.card(casey.id)!.items.map((i) => i.id)).toEqual([item.id]);
    expect(people.card(jordan.id)!.items).toEqual([]);
  });
});

describe('namedPeople', () => {
  it('matches full names and saved other names as whole words only', () => {
    const index = { nameIndex: () => [{ personId: 'a', names: ['jordan hale', 'jo'] }, { personId: 'b', names: ['casey lin'] }] };
    expect(namedPeople(index, ['Thanks Jordan Hale!'])).toEqual(['a']);
    expect(namedPeople(index, ['Ask Casey Lin and Jordan'])).toEqual(['b']);
    expect(namedPeople(index, ['Joking aside'])).toEqual([]);
  });
});
