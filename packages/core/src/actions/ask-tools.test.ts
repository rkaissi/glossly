import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import type { SelectionPayload } from '../types';
import { buildAskPrompt } from './ask';
import { askTools, eventDraft, eventDraftLabel, taskDraft, taskDraftLabel, withAboutMe, type AskToolDeps, type ToolOutcome } from './ask-tools';

// Wednesday, Oct 14 2026, 10 am.
const NOW = new Date(2026, 9, 14, 10);
const saved = { 'jordan hale': { id: 'p1', name: 'Jordan Hale' }, 'casey lin': { id: 'p2', name: 'Casey Lin' } } as Record<string, { id: string; name: string }>;
const personByName = (n: string) => saved[n.trim().toLowerCase()] ?? null;

describe('drafts from the model', () => {
  it('reads a task: the due phrase, the saved person, or the name as written', () => {
    expect(taskDraft({ text: '  Send   the deck ', due: 'Friday', person: 'Jordan Hale', owner: 'me' }, { personByName }, NOW)).toEqual({
      text: 'Send the deck',
      owner: 'me',
      person_id: 'p1',
      person_name: 'Jordan Hale',
      due_at: '2026-10-16',
    });
    const other = taskDraft({ text: 'Share the budget', due: null, person: 'Riley Brooks', owner: 'them' }, { personByName }, NOW)!;
    expect(other).toMatchObject({ person_id: null, person_name: 'Riley Brooks', due_at: null });
    expect(taskDraft({ text: ' ', owner: 'me' }, { personByName }, NOW)).toBeNull();
    expect(taskDraftLabel({ ...other, due_at: '2026-10-15' }, NOW)).toBe('Share the budget, due tomorrow');
  });

  it('reads an event and its saved attendees, or nothing without a day', () => {
    const e = eventDraft({ title: 'Lunch with Jordan', when: 'tomorrow 1pm', end: '2pm', location: 'Northwind Cafe', attendees: ['Jordan Hale', 'Riley Brooks'] }, { personByName }, NOW)!;
    expect(e).toMatchObject({ title: 'Lunch with Jordan', all_day: false, location: 'Northwind Cafe', attendees: ['Jordan Hale', 'Riley Brooks'], personIds: ['p1'] });
    expect(eventDraftLabel(e, NOW)).toBe('Lunch with Jordan, tomorrow, 1:00 PM to 2:00 PM');
    expect(eventDraft({ title: 'Someday', when: 'sometime soon' }, { personByName }, NOW)).toBeNull();
  });
});

describe('askTools', () => {
  function deps(outcome: ToolOutcome = { ok: true, label: '' }) {
    const calls: { tool: string; asked: boolean; label?: string; arg: unknown }[] = [];
    const d: AskToolDeps = {
      personByName,
      now: () => NOW,
      addTask: (t, asked, label) => (calls.push({ tool: 'task', asked, label, arg: t }), outcome.ok ? { ok: true, label } : outcome),
      addEvent: (e, asked, label) => (calls.push({ tool: 'event', asked, label, arg: e }), outcome.ok ? { ok: true, label } : outcome),
      editPerson: (p, asked, label) => (calls.push({ tool: 'person', asked, label, arg: p }), outcome.ok ? { ok: true, label } : outcome),
      addAboutMe: (fact, asked) => (calls.push({ tool: 'about', asked, arg: fact }), outcome.ok ? { ok: true, label: fact } : outcome),
    };
    return { d, calls };
  }
  const run = async (t: { execute?: unknown }, input: unknown) => (t.execute as (i: unknown, o: unknown) => Promise<{ say: string }>)(input, { toolCallId: 'c', messages: [] });

  it('says what it did when asked, and nothing when it only noticed', async () => {
    const { d, calls } = deps();
    const tools = askTools(d);
    expect(await run(tools.add_task, { text: 'Send the deck', due: 'Friday', person: 'Jordan Hale', owner: 'me', asked: true })).toEqual({
      say: 'Added to your tasks: Send the deck, due Fri, Oct 16 (in 2 days)',
    });
    expect(await run(tools.add_event, { title: 'Lunch with Jordan', when: 'tomorrow 1pm', end: null, location: null, attendees: [], asked: false })).toEqual({ say: '' });
    expect(calls.map((c) => [c.tool, c.asked])).toEqual([
      ['task', true],
      ['event', false],
    ]);
  });

  it("adds a line to a saved person's note, and never touches someone not saved", async () => {
    const { d, calls } = deps();
    const tools = askTools(d);
    expect(await run(tools.update_person, { name: 'Casey Lin', add_to_note: 'Works at Acme', relationship: 'friend', asked: true })).toEqual({
      say: 'Updated Casey Lin: "Works at Acme", relationship: friend',
    });
    expect(calls[0]!.arg).toEqual({ personId: 'p2', name: 'Casey Lin', addNote: 'Works at Acme', relationship: 'friend' });
    expect(await run(tools.update_person, { name: 'Riley Brooks', add_to_note: 'Finance', relationship: null, asked: true })).toEqual({
      say: "Riley Brooks isn't in your people yet, so nothing was changed.",
    });
    expect(calls).toHaveLength(1);
  });

  it("says why when it couldn't, and stays quiet about that when it wasn't asked", async () => {
    const { d } = deps({ ok: false, reason: 'You told me that already.' });
    const tools = askTools(d);
    expect(await run(tools.about_me, { fact: 'Works at Acme', asked: true })).toEqual({ say: 'You told me that already.' });
    expect(await run(tools.add_event, { title: 'Party', when: 'someday', end: null, location: null, attendees: [], asked: true })).toEqual({
      say: "I couldn't tell which day that is, so nothing was added.",
    });
  });
});

describe('what Ask knows about the user', () => {
  it('adds a fact unless the same words are already there', () => {
    const list = [{ id: 'a', text: 'Works at Acme.', at: 'x' }];
    expect(withAboutMe(list, 'works at  ACME', 'b', 'y')).toBeNull();
    expect(withAboutMe(list, 'Lives in Lisbon', 'b', 'y')).toEqual([...list, { id: 'b', text: 'Lives in Lisbon', at: 'y' }]);
  });

  it('puts the facts in every prompt, newest kept when there are too many', () => {
    const selection: SelectionPayload = {
      text: 'Hi',
      context_before: '',
      context_after: '',
      source_app: 'notepad.exe',
      window_title: 'x',
      captured_at: '2026-10-14T10:00:00-04:00',
      method: 'uia',
      trigger: 'auto',
      is_editable: false,
      foreground_handle: 1,
    };
    const aboutMe = Array.from({ length: 25 }, (_, i) => ({ id: String(i), text: `Fact ${i}`, at: 'x' }));
    const { prompt } = buildAskPrompt({ ...DEFAULT_SETTINGS, aboutMe }, { selection, now: NOW });
    expect(prompt).toContain('What you know about them:\n- Fact 5\n');
    expect(prompt).toContain('- Fact 24');
    expect(prompt).not.toContain('- Fact 4\n');
  });
});
