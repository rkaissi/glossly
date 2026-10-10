import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { LlmError, type ChatRequest, type LlmProvider } from '../llm/types';
import { detectPeople } from '../people/detect';
import { DEFAULT_SETTINGS } from '../settings';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import type { SelectionPayload } from '../types';
import { buildPromisesPrompt, extractPromises, reminderCutoff, reminderText, savePromises, type ExtractedCommitments } from './promises';
import { detectInputFor } from './who';

const me = { name: 'Rayan Kaissi', emails: ['rayan@example.com'], handles: [] };
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
    return schema.parse(this.answer());
  }
  hasModel() {
    return true;
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

const answer: ExtractedCommitments = {
  commitments: [
    { owner: 'me', person_name: 'Maya Lin', text: "send the slides from Tuesday's review", due_phrase: 'before Friday', confidence: 0.92 },
    { owner: 'them', person_name: 'Maya', text: 'share the slides with Daniel', due_phrase: '', confidence: 0.4 },
    { owner: 'me', person_name: 'Maya Lin', text: "Send the slides from  Tuesday's review", due_phrase: 'Friday', confidence: 0.9 },
  ],
};

let store: Store;
afterEach(() => store?.close());

describe('What did I promise', () => {
  it('tells the model who the user and the author are, and the day, without asking it for dates', () => {
    const det = detectPeople(detectInputFor(selection), me);
    const prompt = buildPromisesPrompt(settings, { selection, author: det.author, authorIsMe: det.authorIsMe }, now);
    expect(prompt).toContain('## The user\nRayan Kaissi (also: rayan@example.com)');
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
    const rows = await extractPromises(llm, people, settings, { selection, author: null, authorIsMe: false }, undefined, now);
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

  it('passes a Local only refusal through', async () => {
    store = new Store(':memory:');
    const llm = new FakeLlm(() => {
      throw new LlmError('local_only', 'Local only is on');
    });
    await expect(extractPromises(llm, new PeopleRepo(store), settings, { selection, author: null, authorIsMe: false })).rejects.toMatchObject({ code: 'local_only' });
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
    expect(r).toEqual({ saved: 4, created: 1 });
    const card = people.card(maya.id)!;
    expect(card.youOwe.map((c) => [c.text, c.due_at])).toEqual([['send the slides', '2026-10-16']]);
    expect(card.interactions).toMatchObject([{ direction: 'inbound', source_app: 'slack.exe' }]);
    const daniel = people.list('daniel')[0]!;
    expect(daniel.open).toBe(2);
    expect(people.card(daniel.id)!.interactions).toEqual([]);
    expect(people.commitments({ status: 'open' }).find((c) => c.text === 'book a room')?.person_id).toBeNull();
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

describe('reminders', () => {
  it('shows today from the reminder hour on, and missed days at any hour', () => {
    expect(reminderCutoff(new Date(2026, 9, 14, 9, 0), 9)).toBe('2026-10-14');
    expect(reminderCutoff(new Date(2026, 9, 14, 8, 59), 9)).toBe('2026-10-13');
    expect(reminderCutoff(new Date(2026, 10, 1, 7, 0), 9)).toBe('2026-10-31');
  });

  it('words the notification by owner and lateness', () => {
    const c = { id: 'c', owner: 'me' as const, text: 'send the slides', due_at: '2026-10-14', status: 'open' as const, person_id: 'p', person_name: 'Maya Lin' };
    expect(reminderText(c, now)).toEqual({ title: 'You promised Maya Lin', body: 'send the slides\nDue today' });
    expect(reminderText({ ...c, owner: 'them', due_at: '2026-10-12T15:00:00-04:00' }, now)).toEqual({
      title: 'Maya Lin promised you',
      body: 'send the slides\nOverdue since Oct 12',
    });
    expect(reminderText({ ...c, person_name: null }, now).title).toBe('You have something due');
  });
});
