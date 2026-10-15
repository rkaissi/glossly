import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LlmError, type ChatRequest, type LlmProvider } from '../llm/types';
import { detectPeople, type DetectedPerson } from '../people/detect';
import { DEFAULT_SETTINGS } from '../settings';
import { CalendarRepo } from '../store/calendar';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { isoNow, type SelectionPayload } from '../types';
import { buildPromisesPrompt, extractPromises, missedPromises, ownerFromText, reminderCutoff, reminderText, savePromises, type ModelCommitments } from './promises';
import { detectInputFor } from './who';

const me = { name: 'Alex Morgan', emails: ['alex@example.com'], handles: [] };
const settings = { ...DEFAULT_SETTINGS, identity: me };
// Wednesday, Oct 14 2026.
const now = new Date(2026, 9, 14, 10, 0);

class FakeLlm implements LlmProvider {
  calls: ChatRequest[] = [];
  constructor(private readonly answer: () => unknown) {}
  stream(): never {
    throw new Error('not used');
  }
  async structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(req);
    return this.loose ? (this.answer() as T) : schema.parse(this.answer());
  }
  usable = true;
  /** Skip schema checks (to feed answers a real model's enum would refuse). */
  loose = false;
  hasModel() {
    return this.usable;
  }
}

const selection: SelectionPayload = {
  text: "Hey! Can you send me the slides from Tuesday's review before Friday? I'll share them with Daniel Park so he can prep.",
  context_before: 'Maya Lin  9:41 AM\n',
  context_after: '',
  source_app: 'slack.exe',
  window_title: '#design | Acme - Slack',
  captured_at: '2026-10-14T10:00:00-04:00',
  method: 'uia',
  trigger: 'auto',
  is_editable: false,
  foreground_handle: 1,
};

const answer: ModelCommitments = {
  commitments: [
    { owner: 'user', person_name: 'Maya Lin', text: "send the slides from Tuesday's review", due_phrase: 'before Friday', confidence: 0.92, change: 'new', open_task: 'none' },
    { owner: 'other', person_name: 'Maya', text: 'share the slides with Daniel', due_phrase: '', confidence: 0.4, change: 'new', open_task: 'none' },
    { owner: 'user', person_name: 'Maya Lin', text: "Send the slides from  Tuesday's review", due_phrase: 'Friday', confidence: 0.9, change: 'new', open_task: 'none' },
  ],
  events: [],
};

let store: Store;
afterEach(() => store?.close());

describe('What did I promise', () => {
  it('tells the model who the user and the author are, and the day, without asking it for dates', () => {
    const det = detectPeople(detectInputFor(selection), me);
    const prompt = buildPromisesPrompt(settings, { selection, author: det.author, authorIsMe: det.authorIsMe }, now);
    expect(prompt).toContain('## The user\nAlex Morgan (also: alex@example.com)');
    expect(prompt).toContain('## Message author\nMaya Lin');
    expect(prompt).toContain('Wednesday, October 14, 2026 (for context only');
    expect(prompt).toContain('Maya Lin  9:41 AM\n[SELECTION]');
    expect(buildPromisesPrompt(settings, { selection, author: null, authorIsMe: true }, now)).toContain('## Message author\nthe user');
  });

  it('extracts on the fast role, resolves due phrases in code, matches people, and drops duplicates', async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const maya = people.create({ name: 'Maya Lin' });
    const llm = new FakeLlm(() => answer);
    const { rows, byRules } = await extractPromises(llm, people, settings, { selection, author: null, authorIsMe: false }, undefined, now);
    expect(byRules).toBeNull();
    expect(llm.calls[0]).toMatchObject({ role: 'fast', action: 'promises', temperature: 0 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'me',
      due_phrase: 'before Friday',
      due_at: '2026-10-16',
      selected: true,
      match: { personId: maya.id, name: 'Maya Lin', kind: 'exact' },
    });
    // A first name alone is offered as the saved person, for the user to confirm ("Maya Lin?").
    expect(rows[1]).toMatchObject({ owner: 'them', due_phrase: null, due_at: null, selected: false, person_name: 'Maya', match: { personId: maya.id, kind: 'fuzzy' } });
  });

  it('drops rows and events the selection does not back, and never makes the user the other person (Step 21)', async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const invite: SelectionPayload = {
      ...selection,
      text: 'Lunch Thursday at 1pm at Northwind Cafe? Can you bring the deck?',
      context_before: 'Jordan Hale\njordan.hale@example.com\n',
      context_after: '\nSend the report by Friday 5pm.\nCan we push the review to Monday?',
      source_app: 'notepad.exe',
    };
    const llm = new FakeLlm(() => ({
      commitments: [
        { owner: 'other', person_name: 'Alex Morgan', text: 'bring the deck', due_phrase: '', confidence: 0.9, change: 'new', open_task: 'none' },
        { owner: 'other', person_name: 'Alex Morgan', text: 'send the report', due_phrase: 'Friday 5pm', confidence: 0.9, change: 'new', open_task: 'none' },
        { owner: 'user', person_name: 'Jordan Hale', text: 'push the review', due_phrase: 'Monday', confidence: 0.9, change: 'new', open_task: 'none' },
      ],
      events: [
        { title: 'Lunch with Jordan', when: 'Thursday at 1pm', end: '', duration_minutes: 0, location: 'Northwind Cafe', people: ['Jordan Hale'], confidence: 0.9 },
        { title: 'Review meeting', when: 'Monday', end: '', duration_minutes: 0, location: '', people: [], confidence: 0.8 },
      ],
    }));
    const author = { name: 'Jordan Hale', email: null, handle: null, role: 'author', knownId: null } as DetectedPerson;
    const { rows, events } = await extractPromises(llm, people, settings, { selection: invite, author, authorIsMe: false }, undefined, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'me', text: 'bring the deck', person_name: 'Jordan Hale' });
    expect(events.map((e) => e.title)).toEqual(['Lunch with Jordan']);
  });

  it('gives a task with no person to the one other person in the selection, never in the user\'s own notes (Step 21)', async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const ask: SelectionPayload = { ...selection, text: 'please review the PR today if you can' };
    const answer = { commitments: [{ owner: 'user', person_name: '', text: 'review the PR', due_phrase: 'today', confidence: 0.9, change: 'new', open_task: 'none' }], events: [] };
    const author = { name: 'Jordan Hale', email: null, handle: null, role: 'author', knownId: null } as DetectedPerson;
    const fromJordan = await extractPromises(new FakeLlm(() => answer), people, settings, { selection: ask, author, authorIsMe: false }, undefined, now);
    expect(fromJordan.rows[0]).toMatchObject({ owner: 'me', person_name: 'Jordan Hale' });
    const note: SelectionPayload = { ...selection, text: 'review the PR today' };
    const mine = await extractPromises(new FakeLlm(() => answer), people, settings, { selection: note, author: null, authorIsMe: true }, undefined, now);
    expect(mine.rows[0]).toMatchObject({ owner: 'me', person_name: null });
  });

  it("reads who owes a task from another writer's words (Step 21)", async () => {
    expect(ownerFromText("I'll get you the contract draft by end of day tomorrow", 'get the contract draft')).toBe('them');
    expect(ownerFromText("I'll book the room for the workshop, leave it with me", 'book the room')).toBe('them');
    expect(ownerFromText('can you send me the forms before friday?', 'send the forms')).toBe('me');
    expect(ownerFromText('please review the PR today', 'review the PR')).toBe('me');
    expect(ownerFromText('Lunch Thursday at 1pm?', 'bring the deck')).toBeNull();
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const draft: SelectionPayload = { ...selection, text: "I'll get you the contract draft by end of day tomorrow" };
    const answer = { commitments: [{ owner: 'user', person_name: 'Maya Chen', text: 'get the contract draft', due_phrase: 'end of day tomorrow', confidence: 0.9, change: 'new', open_task: 'none' }], events: [] };
    const author = { name: 'Maya Chen', email: null, handle: null, role: 'author', knownId: null } as DetectedPerson;
    const r = await extractPromises(new FakeLlm(() => answer), people, settings, { selection: draft, author, authorIsMe: false }, undefined, now);
    expect(r.rows[0]).toMatchObject({ owner: 'them', person_name: 'Maya Chen', due_at: expect.stringMatching(/^2026-10-15T17:00/) });
  });

  it('drops a task one writer asked of another, unless the user asked (Step 21)', async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const text =
      'Casey Lin  9:41 AM\nJordan, can you confirm the venue list by Thursday?\nAlex Morgan  9:47 AM\nJordan, could you also confirm the caterer?\nMaya Chen  9:50 AM\nAlex, can you book the bus?';
    const at = (s: string) => text.indexOf(s);
    const messages = [
      { author: 'Casey Lin', user: false, start: at('Jordan, can') },
      { author: 'Alex Morgan', user: true, start: at('Jordan, could') },
      { author: 'Maya Chen', user: false, start: at('Alex, can') },
    ];
    const row = (person_name: string, text: string) => ({ owner: 'other', person_name, text, due_phrase: '', confidence: 0.9, change: 'new', open_task: 'none' });
    // The model's group-thread mistakes: Casey's ask of Jordan as Casey's, and Maya's ask of the user as hers.
    const answer = { commitments: [row('Casey Lin', 'confirm the venue list'), row('Jordan Hale', 'confirm the caterer'), row('Maya Chen', 'book the bus')], events: [] };
    const input = { selection: { ...selection, text }, author: { name: 'Maya Chen', email: null, handle: null, role: 'author', knownId: null } as DetectedPerson, authorIsMe: false, messages };
    const r = await extractPromises(new FakeLlm(() => answer), people, settings, input, undefined, now);
    expect(r.rows.map((x) => [x.owner, x.person_name, x.text])).toEqual([
      ['them', 'Jordan Hale', 'confirm the caterer'],
      ['me', 'Maya Chen', 'book the bus'],
    ]);
  });

  it("adds the other writer's promise the model left out, from the patterns (Step 21)", async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const text = "Hi both, can you each send me your travel notes by Monday? I'll share the final agenda on Friday.";
    const answer = { commitments: [{ owner: 'user', person_name: 'Maya Chen', text: 'send travel notes', due_phrase: 'Monday', confidence: 0.9, change: 'new', open_task: 'none' }], events: [] };
    const author = { name: 'Maya Chen', email: null, handle: null, role: 'author', knownId: null } as DetectedPerson;
    const r = await extractPromises(new FakeLlm(() => answer), people, settings, { selection: { ...selection, text }, author, authorIsMe: false }, undefined, now);
    expect(r.rows.map((x) => [x.owner, x.person_name, x.text])).toEqual([
      ['me', 'Maya Chen', 'send travel notes'],
      ['them', 'Maya Chen', 'share the final agenda'],
    ]);
    const given = { owner: 'me' as const, person_name: 'Maya Chen', text: 'send travel notes', due_phrase: 'Monday', confidence: 0.9 };
    expect(missedPromises([given], [{ owner: 'them', person_name: 'Maya Chen', text: 'send the travel notes', due_phrase: '', confidence: 0.4 }])).toEqual([]);
  });

  it('passes a Local only refusal through', async () => {
    store = new Store(':memory:');
    const llm = new FakeLlm(() => {
      throw new LlmError('local_only', 'Local only is on');
    });
    await expect(extractPromises(llm, new PeopleRepo(store), settings, { selection, author: null, authorIsMe: false })).rejects.toMatchObject({ code: 'local_only' });
  });

  it('without a usable model, finds promises and requests by patterns', async () => {
    store = new Store(':memory:');
    const llm = new FakeLlm(() => {
      throw new Error('no model call expected');
    });
    llm.usable = false;
    const r = await extractPromises(llm, new PeopleRepo(store), { ...settings, privacy: 'local' }, { selection, author: { name: 'Maya Lin' } as DetectedPerson, authorIsMe: false }, undefined, now);
    expect(llm.calls).toEqual([]);
    expect(r.byRules).toBe('local_only');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ owner: 'me', text: "send me the slides from Tuesday's review", due_phrase: 'before Friday', due_at: '2026-10-16', selected: true, person_name: 'Maya Lin' });
    expect(r.rows[1]).toMatchObject({ owner: 'them', text: 'share them with Daniel Park so he can prep', due_phrase: null, selected: false });
  });

  it('saves rows, creates new people once, and stores the message with its author', () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const maya = people.create({ name: 'Maya Lin' });
    const r = savePromises(
      people,
      [
        { owner: 'me', text: 'send the slides', due_at: '2026-10-16', person: { kind: 'existing', id: maya.id } },
        { owner: 'them', text: 'prep for the client call', due_at: null, person: { kind: 'new', name: 'Daniel Park' } },
        { owner: 'me', text: 'intro Daniel to legal', due_at: null, person: { kind: 'new', name: 'daniel park' } },
        { owner: 'me', text: 'book a room', due_at: null, person: null },
      ],
      { message: selection.text, sourceApp: 'slack.exe', authorPersonId: maya.id, authorIsMe: false },
    );
    expect(r).toEqual({ saved: 4, created: 1, updated: 0 });
    const card = people.card(maya.id)!;
    expect(card.youOwe.map((c) => [c.text, c.due_at])).toEqual([['send the slides', '2026-10-16']]);
    expect(card.interactions).toMatchObject([{ direction: 'inbound', source_app: 'slack.exe' }]);
    const daniel = people.list('daniel')[0]!;
    expect(daniel.open).toBe(2);
    expect(people.card(daniel.id)!.interactions).toEqual([]);
    expect(people.commitments({ status: 'open' }).find((c) => c.text === 'book a room')?.person_id).toBeNull();
  });

  it("takes the full name and details from Who's reader for someone not saved yet", async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const llm = new FakeLlm(() => ({
      commitments: [
        { owner: 'user', person_name: 'Daniel', text: 'intro Daniel to legal', due_phrase: '', confidence: 0.8, change: 'new', open_task: 'none' },
        { owner: 'other', person_name: 'Priya', text: 'send the budget', due_phrase: '', confidence: 0.8, change: 'new', open_task: 'none' },
      ],
      events: [],
    }));
    const detected = [
      { name: 'Daniel Park', email: 'daniel.park@example.com', handle: null, role: 'mentioned' as const, knownId: null, detail: 'legal lead at Acme', about: 'joins the call', relationship: 'colleague' as const },
      { name: 'Priya Shah', email: null, handle: null, role: 'mentioned' as const, knownId: null, relationship: 'professional' as const },
      { name: 'Priya Rao', email: null, handle: null, role: 'mentioned' as const, knownId: null },
    ];
    const { rows } = await extractPromises(llm, people, settings, { selection, author: null, authorIsMe: false }, undefined, now, Promise.resolve(detected));
    expect(rows[0]).toMatchObject({
      person_name: 'Daniel Park',
      match: null,
      details: { email: 'daniel.park@example.com', note: 'legal lead at Acme. joins the call', relationship: 'colleague' },
    });
    // Two Priyas: which one is unclear, so the name stays as written and nothing is attached.
    expect(rows[1]).toMatchObject({ person_name: 'Priya', details: null });

    savePromises(people, [{ owner: 'me', text: 'intro Daniel to legal', due_at: null, person: { kind: 'new', name: 'Daniel Park', ...rows[0]!.details } }], {
      message: selection.text,
      sourceApp: 'slack.exe',
      authorPersonId: null,
      authorIsMe: false,
    });
    const daniel = people.card(people.list('daniel')[0]!.id)!;
    expect(daniel).toMatchObject({ relationship: 'colleague', note: 'legal lead at Acme. joins the call' });
    expect(daniel.aliases).toContainEqual({ kind: 'email', value: 'daniel.park@example.com' });
  });

  it('stores the message as outbound when the user wrote it', () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    savePromises(people, [{ owner: 'me', text: 'send the deck', due_at: null, person: { kind: 'new', name: 'Sam Lee' } }], {
      message: "I'll send the deck tomorrow",
      sourceApp: 'slack.exe',
      authorPersonId: null,
      authorIsMe: true,
    });
    const sam = people.list()[0]!;
    expect(people.card(sam.id)!.interactions).toMatchObject([{ direction: 'outbound' }]);
  });
});

describe('Tasks and open tasks (decision 36)', () => {
  const fromJordan: SelectionPayload = { ...selection, text: 'Here is the budget. Can we push the deck review to Monday?', context_before: 'Jordan Hale  9:41 AM\n' };

  function seed() {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const jordan = people.create({ name: 'Jordan Hale' });
    const budget = people.addCommitment({ person_id: jordan.id, owner: 'them', text: 'send the budget', due_at: '2026-10-13', source_interaction_id: null });
    const deck = people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'review the deck', due_at: '2026-10-15', source_interaction_id: null });
    const intro = people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'intro Jordan to Casey', due_at: null, source_interaction_id: null });
    people.addCommitment({ person_id: null, owner: 'me', text: 'renew passport', due_at: null, source_interaction_id: null });
    return { people, jordan, budget, deck, intro };
  }
  const author = { name: 'Jordan Hale', email: null, handle: null, role: 'author' as const, knownId: null };

  it('sends the open tasks with the author, and turns the answer into done and moved rows plus the rest of the open list', async () => {
    const { people, budget, deck, intro } = seed();
    const llm = new FakeLlm(() => ({
      commitments: [
        { owner: 'other', person_name: 'Jordan Hale', text: 'send the budget', due_phrase: '', confidence: 0.9, change: 'done', open_task: 't1' },
        { owner: 'user', person_name: 'Jordan Hale', text: 'review the deck', due_phrase: 'Monday', confidence: 0.9, change: 'moved', open_task: 't2' },
        // A second row about the same task is dropped.
        { owner: 'user', person_name: 'Jordan Hale', text: 'review the deck again', due_phrase: '', confidence: 0.9, change: 'same', open_task: 't2' },
      ],
      events: [],
    }));
    const r = await extractPromises(llm, people, settings, { selection: fromJordan, author, authorIsMe: false, people: [author] }, undefined, now);
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain('## Open tasks with these people');
    expect(prompt).toContain('t1: Jordan Hale owes the user: send the budget (due 2026-10-13)');
    expect(prompt).not.toContain('renew passport');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ change: 'done', existing: { id: budget.id }, owner: 'them', text: 'send the budget', selected: true });
    expect(r.rows[1]).toMatchObject({ change: 'moved', existing: { id: deck.id }, due_at: '2026-10-19', due_phrase: 'Monday', selected: true });
    expect(r.open.map((t) => t.id)).toEqual([intro.id]);

    const saved = savePromises(people, r.rows.map((row) => ({ change: row.change, existingId: row.existing!.id, owner: row.owner, text: row.text, due_at: row.due_at, person: null })), {
      message: fromJordan.text,
      sourceApp: 'slack.exe',
      authorPersonId: null,
      authorIsMe: false,
    });
    expect(saved).toEqual({ saved: 0, created: 0, updated: 2 });
    expect(people.getCommitment(budget.id)!.status).toBe('done');
    expect(people.getCommitment(deck.id)).toMatchObject({ status: 'open', due_at: '2026-10-19', notified_at: null });
  });

  it('treats a move without a readable new date as the same task, and an unknown key as new', async () => {
    const { people, deck } = seed();
    const llm = new FakeLlm(() => ({
      commitments: [
        { owner: 'user', person_name: 'Jordan Hale', text: 'review the deck', due_phrase: 'later', confidence: 0.9, change: 'moved', open_task: 't2' },
        { owner: 'user', person_name: 'Jordan Hale', text: 'book the venue', due_phrase: '', confidence: 0.9, change: 'done', open_task: 't9' },
      ],
      events: [],
    }));
    // The schema's enum would refuse t9 from a real model; the fake skips validation of that, so code must cope.
    llm.loose = true;
    const sel: SelectionPayload = { ...fromJordan, text: 'Can we push the deck review to later? And book the venue.' };
    const r = await extractPromises(llm, people, settings, { selection: sel, author, authorIsMe: false, people: [author] }, undefined, now);
    expect(r.rows[0]).toMatchObject({ change: 'same', existing: { id: deck.id }, selected: false, due_at: '2026-10-15' });
    expect(r.rows[1]).toMatchObject({ change: 'new', existing: null, text: 'book the venue' });
  });

  it('without a model, matches pattern rows to open tasks by their words', async () => {
    const { people, deck } = seed();
    const llm = new FakeLlm(() => {
      throw new Error('no model call expected');
    });
    llm.usable = false;
    const sel: SelectionPayload = { ...fromJordan, text: 'Can you review the deck by Friday? Can you also book the venue?' };
    const r = await extractPromises(llm, people, settings, { selection: sel, author, authorIsMe: false, people: [author] }, undefined, now);
    expect(r.rows[0]).toMatchObject({ change: 'moved', existing: { id: deck.id }, due_at: '2026-10-16', due_phrase: 'by Friday' });
    expect(r.rows[1]).toMatchObject({ change: 'new', text: 'book the venue' });
    expect(r.open.map((t) => t.text).sort()).toEqual(['intro Jordan to Casey', 'send the budget']);
  });
});

describe('events from the same call (decision 37)', () => {
  it('returns events beside tasks, with the saved events on those days', async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const calendar = new CalendarRepo(store);
    calendar.add({ title: 'Dentist', starts_at: '2026-10-15T09:00:00' + isoNow(now).slice(19), ends_at: null, all_day: false, location: null, attendees: [], personIds: [] }, null);
    calendar.add({ title: 'Other day', starts_at: '2026-10-16', ends_at: null, all_day: true, location: null, attendees: [], personIds: [] }, null);
    const llm = new FakeLlm(() => ({
      commitments: [{ owner: 'user', person_name: 'Jordan Hale', text: 'bring the deck', due_phrase: 'Thursday', confidence: 0.8, change: 'new', open_task: 'none' }],
      events: [{ title: 'Lunch with Jordan', when: 'Thursday 1pm', end: '', duration_minutes: 90, location: 'Northwind Cafe', people: ['Jordan Hale'], confidence: 0.9 }],
    }));
    const invite: SelectionPayload = { ...selection, text: 'Lunch with Jordan Thursday at 1pm at Northwind Cafe? Can you bring the deck?' };
    const r = await extractPromises(llm, people, settings, { selection: invite, author: null, authorIsMe: false }, undefined, now, [], calendar);
    expect(r.rows).toHaveLength(1);
    expect(r.events).toEqual([
      expect.objectContaining({ title: 'Lunch with Jordan', all_day: false, location: 'Northwind Cafe', attendees: ['Jordan Hale'], people: [], selected: true }),
    ]);
    expect(r.events[0]!.starts_at!.slice(0, 16)).toBe('2026-10-15T13:00');
    expect(r.events[0]!.ends_at!.slice(0, 16)).toBe('2026-10-15T14:30');
    expect(r.sameDay.map((e) => e.title)).toEqual(['Dentist']);
    expect(r.events[0]!.duplicate ?? null).toBeNull();
  });

  it('starts an event that looks already saved unchecked, with what it matched (decision 78)', async () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const calendar = new CalendarRepo(store);
    const saved = calendar.add({ title: 'Jordan lunch', starts_at: '2026-10-15T13:30:00' + isoNow(now).slice(19), ends_at: null, all_day: false, location: null, attendees: [], personIds: [] }, null);
    const llm = new FakeLlm(() => ({
      commitments: [],
      events: [{ title: 'Lunch with Jordan', when: 'Thursday 1pm', end: '', duration_minutes: 90, location: '', people: [], confidence: 0.9 }],
    }));
    const invite: SelectionPayload = { ...selection, text: 'Lunch with Jordan Thursday at 1pm?' };
    const r = await extractPromises(llm, people, settings, { selection: invite, author: null, authorIsMe: false }, undefined, now, [], calendar);
    expect(r.events[0]).toMatchObject({ selected: false, duplicate: { id: saved.id, title: 'Jordan lunch' } });
  });

  it('without a model, an invitation is an event and its request is a task', async () => {
    store = new Store(':memory:');
    const llm = new FakeLlm(() => {
      throw new Error('no model call expected');
    });
    llm.usable = false;
    const sel: SelectionPayload = { ...selection, text: 'Lunch Thursday at 1pm at Northwind Cafe? Can you bring the deck?' };
    const author = { name: 'Jordan Hale', email: null, handle: null, role: 'author' as const, knownId: null };
    const r = await extractPromises(llm, new PeopleRepo(store), settings, { selection: sel, author, authorIsMe: false }, undefined, now);
    expect(r.events.map((e) => [e.title, e.location])).toEqual([['Lunch with Jordan', 'Northwind Cafe']]);
    expect(r.rows.map((x) => [x.owner, x.text])).toEqual([['me', 'bring the deck']]);
  });
});

describe('reminders', () => {
  it('shows today from the reminder hour on, and missed days at any hour', () => {
    expect(reminderCutoff(new Date(2026, 9, 14, 9, 0), 9)).toBe('2026-10-14');
    expect(reminderCutoff(new Date(2026, 9, 14, 8, 59), 9)).toBe('2026-10-13');
    expect(reminderCutoff(new Date(2026, 10, 1, 7, 0), 9)).toBe('2026-10-31');
  });

  it('words the notification by owner and lateness', () => {
    const c = { id: 'c', owner: 'me' as const, text: 'send the slides', due_at: '2026-10-14', status: 'open' as const, completed_at: null, person_id: 'p', person_name: 'Maya Lin' };
    expect(reminderText(c, now)).toEqual({ title: 'You promised Maya Lin', body: 'send the slides\nDue today' });
    expect(reminderText({ ...c, owner: 'them', due_at: '2026-10-12T15:00:00-04:00' }, now)).toEqual({
      title: 'Maya Lin promised you',
      body: 'send the slides\nOverdue since Oct 12',
    });
    expect(reminderText({ ...c, person_name: null }, now).title).toBe('You have something due');
  });
});
