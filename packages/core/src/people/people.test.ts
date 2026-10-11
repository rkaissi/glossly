import { afterEach, describe, expect, it } from 'vitest';
import { buildWho, detectInputFor, personBadges } from '../actions/who';
import { AliasTakenError, PeopleRepo, aliasKindOf } from '../store/people';
import { Store } from '../store/store';
import type { SelectionPayload } from '../types';
import { detectPeople, type DetectInput } from './detect';
import { FIRST_NAME_SCORE, resolvePerson } from './resolve';

const me = { name: 'Alex Morgan', emails: ['alex@example.com'], handles: ['alexm'] };
const noOne = { name: '', emails: [], handles: [] };

let store: Store;
afterEach(() => store?.close());

function repo(): PeopleRepo {
  store = new Store(':memory:');
  let t = 0;
  // Increasing timestamps keep "newest first" deterministic.
  return new PeopleRepo(store, () => `2026-10-10T10:${String(t++).padStart(2, '0')}:00-04:00`);
}

function input(over: Partial<DetectInput>): DetectInput {
  return { text: '', before: '', after: '', source_app: 'slack.exe', window_title: '', ...over };
}

describe('PeopleRepo', () => {
  it('creates people with normalized aliases and refuses an alias someone else has', () => {
    const r = repo();
    const sam = r.create({ name: '  Sam   Lee ', aliases: [{ kind: 'email', value: 'Sam@Acme.com' }, { kind: 'handle', value: '@samlee' }] });
    expect(sam.name).toBe('Sam Lee');
    expect(sam.aliases).toEqual([
      { kind: 'email', value: 'sam@acme.com' },
      { kind: 'handle', value: 'samlee' },
    ]);
    const other = r.create({ name: 'Sam Li' });
    expect(() => r.addAlias(other.id, 'email', 'sam@acme.com')).toThrow(AliasTakenError);
    expect(r.addAlias(other.id, 'name', 'Sammy').aliases).toEqual([{ kind: 'name', value: 'Sammy' }]);
    expect(r.byAlias('email', 'SAM@acme.com')).toBe(sam.id);
    expect(r.byAlias('handle', '@SamLee')).toBe(sam.id);
    expect(r.byName('sammy')).toBe(other.id);
    expect(r.list('acme').map((p) => p.name)).toEqual(['Sam Lee']);
  });

  it('keeps the old name as an alias on rename', () => {
    const r = repo();
    const p = r.create({ name: 'Dana' });
    const renamed = r.update(p.id, { name: 'Dana Ortiz', note: 'Staging DB owner' });
    expect(renamed.note).toBe('Staging DB owner');
    expect(renamed.aliases).toEqual([{ kind: 'name', value: 'Dana' }]);
    expect(r.byName('dana')).toBe(p.id);
  });

  it('links saved items that mention the person, including ones saved before they existed', () => {
    const r = repo();
    const coll = store.listCollections()[0]!;
    const item = store.insertItem({ collection_id: coll.id, kind: 'selection', text: 'Maya wants the slides', why: null, source_app: 'slack.exe', window_title: null, data_json: null });
    store.linkItemEntity(item.id, store.upsertEntity('person', 'Maya Lin'));
    const maya = r.create({ name: 'Maya Lin' });
    expect(r.get(maya.id)!.entity_id).not.toBeNull();
    expect(r.items(maya.id).map((i) => [i.text, i.collection])).toEqual([['Maya wants the slides', coll.name]]);
    expect(r.seenIn('slack.exe').has(maya.id)).toBe(true);
    expect(r.seenIn('chrome.exe').has(maya.id)).toBe(false);
  });

  it('merges only when asked, moving aliases, interactions, and commitments', () => {
    const r = repo();
    const a = r.create({ name: 'Sam Lee', note: 'PM at Acme' });
    const b = r.create({ name: 'Samuel Lee', aliases: [{ kind: 'email', value: 'sam@acme.com' }], note: 'Met at the offsite' });
    r.addInteraction({ person_id: b.id, direction: 'inbound', text: 'hello', source_app: 'slack.exe' });
    r.addCommitment({ person_id: b.id, owner: 'me', text: 'send the deck', due_at: '2026-10-16' });
    const merged = r.merge(a.id, b.id);
    expect(r.get(b.id)).toBeNull();
    expect(merged.aliases).toEqual(
      expect.arrayContaining([
        { kind: 'name', value: 'Samuel Lee' },
        { kind: 'email', value: 'sam@acme.com' },
      ]),
    );
    expect(merged.note).toBe('PM at Acme\nMet at the offsite');
    const card = r.card(a.id)!;
    expect(card.youOwe.map((c) => c.text)).toEqual(['send the deck']);
    expect(card.interactions).toHaveLength(1);
    expect(() => r.merge(a.id, a.id)).toThrow();
  });

  it('lists commitments by due date and finds the ones due for a notification', () => {
    const r = repo();
    const p = r.create({ name: 'Sam Lee' });
    const later = r.addCommitment({ person_id: p.id, owner: 'them', text: 'review the doc', due_at: '2026-10-20' });
    const timed = r.addCommitment({ person_id: p.id, owner: 'me', text: 'call back', due_at: '2026-10-12T15:00:00-04:00' });
    r.addCommitment({ person_id: null, owner: 'me', text: 'file expenses', due_at: null });
    expect(r.commitments({ status: 'open' }).map((c) => c.text)).toEqual(['call back', 'review the doc', 'file expenses']);
    expect(r.dueUnnotified('2026-10-12').map((c) => c.id)).toEqual([timed.id]);
    r.markNotified(timed.id);
    expect(r.dueUnnotified('2026-10-20').map((c) => c.id)).toEqual([later.id]);
    r.setCommitmentStatus(later.id, 'done');
    expect(r.dueUnnotified('2026-10-20')).toEqual([]);
    expect(r.card(p.id)!.theyOwe).toEqual([]);
  });

  it('keeps pasted voice samples first, caps edited ones, and prefers the same person and kind of app', () => {
    const r = repo();
    for (let i = 0; i < 25; i++) r.addVoice(`reply ${i}`, 'inserted_edited', { channel: 'messaging', original: `draft ${i}` });
    r.addVoice('my pasted sample', 'pasted');
    expect(r.voiceSamples().filter((v) => v.origin === 'inserted_edited')).toHaveLength(20);
    expect(r.voiceForPrompt(3)).toEqual(['my pasted sample', 'reply 24', 'reply 23']);
    const p = r.create({ name: 'Jordan Hale' });
    r.addVoice('to jordan by email', 'inserted_edited', { channel: 'email', personId: p.id });
    r.addVoice('newest, in email', 'inserted_edited', { channel: 'email' });
    expect(r.voiceForPrompt(3, { channel: 'email', personId: p.id })).toEqual(['my pasted sample', 'to jordan by email', 'newest, in email']);
    expect(r.voiceForPrompt(2, { channel: 'messaging' })).toEqual(['my pasted sample', 'reply 24']);
    expect(r.editedPairs(3).map((x) => x.original)).toEqual(['draft 24', 'draft 23', 'draft 22']);
  });

  it('stores what Reply learned, forgets one habit, and remembers removed notes', () => {
    const r = repo();
    const p = r.create({ name: 'Jordan Hale' });
    r.addStyleSignals([{ dimension: 'length', pole: 'shorter', weight: 1 }], { channel: 'email', personId: p.id });
    r.addStyleSignals([{ dimension: 'tone', pole: 'playful', weight: 1 }], { channel: 'messaging', personId: null });
    expect(r.styleSignals()).toHaveLength(2);
    r.forgetStyle('length', { channel: null, personId: p.id });
    expect(r.styleSignals().map((x) => x.dimension)).toEqual(['tone']);
    const [note] = r.replaceStyleNotes(['Drops the greeting', 'Signs off with a dash']);
    r.removeStyleNote(note!.id);
    expect(r.styleNotes().map((n) => n.text)).toEqual(['Signs off with a dash']);
    expect(r.removedStyleNotes()).toEqual(['Drops the greeting']);
  });

  it('deletes a person with their records', () => {
    const r = repo();
    const p = r.create({ name: 'Sam Lee', aliases: [{ kind: 'email', value: 'sam@acme.com' }] });
    r.addCommitment({ person_id: p.id, owner: 'me', text: 'x', due_at: null });
    expect(r.delete(p.id)).toBe(true);
    expect(r.byAlias('email', 'sam@acme.com')).toBeNull();
    expect(r.commitments()).toEqual([]);
  });

  it('guesses alias kinds', () => {
    expect(aliasKindOf('sam@acme.com')).toBe('email');
    expect(aliasKindOf('@sam')).toBe('handle');
    expect(aliasKindOf('Sammy')).toBe('name');
  });
});

describe('detectPeople', () => {
  it('takes the last chat header as the author and leaves the user out', () => {
    const d = detectPeople(
      input({
        text: 'Elena Moretti  3:12 PM\nWho owns the billing migration now that Chris moved teams?\nSam Lee  3:15 PM\nI think it went to Fatima Noor, but ask Alex Morgan',
      }),
      me,
    );
    expect(d.author).toMatchObject({ name: 'Sam Lee', role: 'author' });
    expect(d.people.map((p) => p.name)).toEqual(['Sam Lee', 'Fatima Noor']);
    expect(d.authorIsMe).toBe(false);
  });

  it('finds the header in the context before a single selected message', () => {
    const d = detectPeople(input({ before: 'Maya Lin  9:41 AM\n', text: 'Can you send me the slides before Friday?' }), me);
    expect(d.author?.name).toBe('Maya Lin');
  });

  it('knows when the user wrote the selected message', () => {
    const d = detectPeople(input({ before: 'Alex  9:41 AM\n', text: "I'll send the slides to Daniel Park tomorrow" }), me);
    expect(d.authorIsMe).toBe(true);
    expect(d.author).toBeNull();
    expect(d.people.map((p) => p.name)).toEqual(['Daniel Park']);
  });

  it('reads email From lines, sign-offs, and DM titles', () => {
    expect(detectPeople(input({ before: 'From: Helen Park <Helen.Park@lumen.co>\nTo: Alex\n', text: 'Could you share the pricing?' }), me).author).toMatchObject({
      name: 'Helen Park',
      email: 'helen.park@lumen.co',
    });
    expect(detectPeople(input({ text: 'Hi Alex,\n\nCould you share that version?\n\nBest,\nHelen' }), me).author?.name).toBe('Helen');
    expect(detectPeople(input({ text: 'is staging getting wiped tonight?', window_title: 'Dana Ortiz (DM) | Northwind - Slack' }), me).author?.name).toBe('Dana Ortiz');
    expect(detectPeople(input({ text: 'From: alex@example.com\nsee attached' }), me).authorIsMe).toBe(true);
  });

  it('pairs names with emails and adds handles and known people', () => {
    const d = detectPeople(
      input({ text: 'Looping in Grace Hopper <grace@navy.mil> and @tomas, plus the notes from sammy' }),
      noOne,
      [{ id: 'p1', name: 'Sam Lee', aliases: ['sammy'] }],
    );
    expect(d.people.map((p) => [p.name, p.email, p.handle, p.knownId])).toEqual([
      ['Grace Hopper', 'grace@navy.mil', null, null],
      ['Sam Lee', null, null, 'p1'],
      [null, null, 'tomas', null],
    ]);
  });

  it('does not take labels for speakers', () => {
    expect(detectPeople(input({ text: 'Note: the build is green\nUpdate: shipped' }), me).author).toBeNull();
  });
});

describe('resolvePerson', () => {
  it('matches email, handle, then name, and fuzzy only among people seen in the app', () => {
    const r = repo();
    const sam = r.create({ name: 'Sam Lee', aliases: [{ kind: 'email', value: 'sam@acme.com' }, { kind: 'handle', value: 'tomas' }] });
    expect(resolvePerson(r, { name: null, email: 'SAM@acme.com' }, 'slack.exe')).toEqual({ kind: 'exact', personId: sam.id, via: 'email' });
    expect(resolvePerson(r, { name: 'tomas' }, 'slack.exe')).toEqual({ kind: 'exact', personId: sam.id, via: 'handle' });
    expect(resolvePerson(r, { name: 'sam lee' }, 'slack.exe')).toEqual({ kind: 'exact', personId: sam.id, via: 'name' });
    // Not seen in Slack yet: no fuzzy match.
    expect(resolvePerson(r, { name: 'Sam Leee' }, 'slack.exe')).toEqual({ kind: 'none' });
    r.addInteraction({ person_id: sam.id, direction: 'inbound', text: 'hi', source_app: 'slack.exe' });
    const fuzzy = resolvePerson(r, { name: 'Sam Leee' }, 'slack.exe');
    expect(fuzzy).toMatchObject({ kind: 'fuzzy', personId: sam.id });
    expect(resolvePerson(r, { name: 'Sam Leee' }, 'chrome.exe')).toEqual({ kind: 'none' });
    expect(resolvePerson(r, { name: 'Sam Li' }, 'slack.exe')).toEqual({ kind: 'none' });
  });

  it('asks about a saved person when only the first name is shown, in any app', () => {
    const r = repo();
    const jordan = r.create({ name: 'Jordan Hale' });
    const morgan = r.create({ name: 'Morgan' });
    expect(resolvePerson(r, { name: 'Jordan' }, 'chrome.exe')).toEqual({ kind: 'fuzzy', personId: jordan.id, score: FIRST_NAME_SCORE });
    expect(resolvePerson(r, { name: 'Morgan Ellis' }, 'chrome.exe')).toMatchObject({ kind: 'fuzzy', personId: morgan.id });
    // Two full names with the same first name are different people unless the user says so.
    expect(resolvePerson(r, { name: 'Jordan Reyes' }, 'chrome.exe')).toEqual({ kind: 'none' });
    expect(resolvePerson(r, { name: 'Jo' }, 'chrome.exe')).toEqual({ kind: 'none' });
    // Two saved Jordans: the one seen in this app is offered.
    const other = r.create({ name: 'Jordan Reyes' });
    r.addInteraction({ person_id: other.id, direction: 'inbound', text: 'hi', source_app: 'discord.exe' });
    expect(resolvePerson(r, { name: 'Jordan' }, 'discord.exe')).toMatchObject({ kind: 'fuzzy', personId: other.id });
  });
});

describe('Who is this', () => {
  const selection = (over: Partial<SelectionPayload> = {}): SelectionPayload => ({
    text: 'Can you send the slides before Friday? Daniel Park needs them.',
    context_before: 'Maya Lin  9:41 AM\n',
    context_after: '',
    source_app: 'slack.exe',
    window_title: '#design | Acme - Slack',
    captured_at: '2026-10-10T10:00:00-04:00',
    method: 'uia',
    trigger: 'auto',
    is_editable: false,
    foreground_handle: 1,
    ...over,
  });

  it('prefers tier 2 around the selection', () => {
    const text = 'Bea  7:02 PM\nhello\nTheo  7:04 PM\nworks for me';
    const container = { text, selection_start: text.indexOf('works'), selection_length: 12, source: 'container' as const };
    const inp = detectInputFor(selection({ text: 'works for me' }), container);
    expect(inp.before).toBe('Bea  7:02 PM\nhello\nTheo  7:04 PM\n');
    expect(detectPeople(inp, me).author?.name).toBe('Theo');
  });

  it('builds entries with cards, a fuzzy suggestion, and badges for people with open items', () => {
    const r = repo();
    const maya = r.create({ name: 'Maya Lin' });
    r.addCommitment({ person_id: maya.id, owner: 'me', text: 'send the slides', due_at: '2026-10-16' });
    const dan = r.create({ name: 'Daniel Parks' });
    r.addInteraction({ person_id: dan.id, direction: 'inbound', text: 'hi', source_app: 'slack.exe' });
    const det = detectPeople(detectInputFor(selection()), me, store.listKnownPeople());
    const view = buildWho(r, det, 'slack.exe', true);
    expect(view.entries.map((e) => [e.detected.name, e.match, e.person?.name ?? null])).toEqual([
      ['Maya Lin', 'exact', 'Maya Lin'],
      ['Daniel Park', 'fuzzy', 'Daniel Parks'],
    ]);
    expect(view.entries[0]!.person!.youOwe.map((c) => c.text)).toEqual(['send the slides']);
    expect(personBadges(r, det, 'slack.exe')).toEqual([{ kind: 'person', personId: maya.id, label: 'Maya Lin · 1 open' }]);
  });
});
