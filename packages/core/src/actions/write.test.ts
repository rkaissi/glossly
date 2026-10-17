import { describe, expect, it } from 'vitest';
import type { ContextTask } from '../context/retrieve';
import type { ChatRequest, LlmProvider } from '../llm/types';
import type { PersonCard } from '../people/types';
import { DEFAULT_SETTINGS } from '../settings';
import { buildWritePrompt, mergeWriteNotes, NOTHING_TO_WRITE, write, writeSuggestions, type WriteInput } from './write';

const settings = { ...DEFAULT_SETTINGS, identity: { name: 'Alex Morgan', emails: [], handles: [] } };
// Wednesday, Oct 14, 2026, 10:00 local.
const now = new Date(2026, 9, 14, 10, 0);

const jordan: PersonCard = {
  id: 'p1',
  name: 'Jordan Hale',
  relationship: 'professional',
  note: 'Runs marketing at Acme',
  aliases: [],
  youOwe: [{ id: 'c1', owner: 'me', text: 'Send Jordan the Acme deck', due_at: '2026-10-14', status: 'open', completed_at: null, person_id: 'p1', person_name: 'Jordan Hale' }],
  theyOwe: [],
  interactions: [],
  items: [],
  events: [],
  created_at: '2026-10-01T10:00:00-04:00',
};

const task = (over: Partial<ContextTask>): ContextTask => ({
  id: 't',
  owner: 'me',
  text: 'Book the room',
  due_at: null,
  status: 'open',
  completed_at: null,
  person_id: null,
  person_name: null,
  reason: 'similar',
  similarity: 0.6,
  ...over,
});

const email = 'Hi Jordan,\n\nThanks for the nudge. Quick status on the deck: ';
const base: WriteInput = {
  target: 'email',
  rich: false,
  app: 'olk.exe',
  title: 'Re: Acme launch deck - Outlook',
  surroundings: { text: `${email}\n\nFrom: Jordan Hale\nWhere are we with the deck?`, caret: email.length, source: 'caret' },
  notes: [],
  voice: [],
};

describe('Write here', () => {
  it('puts the user, voice, the place, now, the person written to, and the text at the cursor in the prompt', () => {
    const p = buildWritePrompt(
      settings,
      { ...base, to: { name: 'Jordan Hale', person: jordan }, voice: [{ text: 'sounds good, will send by 5', from: 'email' }], preferences: ['Shorter than drafted, in email'], styleNotes: ['No em dashes'] },
      now,
    );
    expect(p).toContain('## The user\nAlex Morgan');
    expect(p).toContain('<sample from="email">\nsounds good, will send by 5\n</sample>');
    expect(p).toContain('## What the user tends to pick\n- Shorter than drafted, in email');
    expect(p).toContain('## Notes on how the user writes\n- No em dashes');
    expect(p).toContain('## Where the text goes\nan email: ');
    expect(p).toContain('## Now\nWednesday, October 14, 2026');
    expect(p).toContain('## Writing to\nJordan Hale');
    expect(p).toContain('The user owes them:\n- Send Jordan the Acme deck');
    expect(p).toContain('Quick status on the deck: [CURSOR]');
    // Stable parts before the per-spot ones, for the prompt cache.
    expect(p.indexOf('## Voice samples')).toBeLessThan(p.indexOf('## Where the text goes'));
    expect(p.indexOf('## Now')).toBeLessThan(p.indexOf('## What the user is writing'));
    expect(p).not.toContain('## What the user asked for');
    expect(p).not.toContain('keeps its own lists');
  });

  it('adds saved people, tasks, and events, without repeating the open tasks of the person written to', () => {
    const p = buildWritePrompt(
      settings,
      {
        ...base,
        to: { name: 'Jordan Hale', person: jordan },
        context: {
          people: [
            { id: 'p1', name: 'Jordan Hale', relationship: 'professional', note: null, reason: 'given', similarity: null },
            { id: 'p2', name: 'Casey Lin', relationship: 'colleague', note: 'Owns the customer quotes', reason: 'named', similarity: null },
          ],
          tasks: [task({ id: 'c1', text: 'Send Jordan the Acme deck', person_id: 'p1', person_name: 'Jordan Hale' }), task({ id: 't2', text: 'Finish the pricing slides', status: 'done', completed_at: '2026-10-13' })],
          events: [{ id: 'e1', title: 'Acme review', starts_at: '2026-10-15T10:00:00-04:00', ends_at: '2026-10-15T11:00:00-04:00', all_day: false, location: null, attendees: [], people: [], source_app: null, created_at: '', reason: 'similar', similarity: 0.7 }],
        },
      },
      now,
    );
    expect(p).toContain('## What the user has saved');
    expect(p).toContain('- Casey Lin: colleague; Owns the customer quotes');
    expect(p).not.toContain('- Jordan Hale: professional');
    expect(p).toContain('Finish the pricing slides');
    expect(p.match(/Send Jordan the Acme deck/g)).toHaveLength(1);
    expect(p).toContain('Calendar:\n- [tomorrow, ');
    expect(p).toContain('] Acme review');
  });

  it('numbers saved notes with their day and why, and keeps a request and a change', () => {
    const p = buildWritePrompt(
      settings,
      {
        ...base,
        target: 'document',
        rich: true,
        surroundings: null,
        notes: [{ id: 'i1', text: 'Launch target: Nov 12', why: 'for the review', created_at: '2026-10-09T09:00:00-04:00' }],
        request: 'agenda for   Thursday',
        change: { previous: '1. Pricing\n2. Quotes', asks: ['shorter', 'casual'], note: 'mention the launch date' },
      },
      now,
    );
    expect(p).toContain('## Saved notes\n<note n="1" saved="2026-10-09">\nLaunch target: Nov 12\nWhy it was saved: for the review\n</note>');
    expect(p).toContain('The editor keeps its own lists: write list items as plain lines.');
    expect(p).toContain('## What the user is writing\nNothing yet');
    expect(p).toContain('## What the user asked for\n"agenda for Thursday"');
    expect(p).toContain('## The text written before\n<previous>\n1. Pricing\n2. Quotes\n</previous>');
    expect(p).toContain('## Change it\n- Shorter.\n- More casual.\n- In their words: "mention the launch date"');
  });

  it('merges snippets and recalled notes, snippets first, without repeats', () => {
    const notes = mergeWriteNotes(
      [{ id: 'a', text: 'A', why: null, created_at: '2026-10-10' }],
      [
        { itemId: 'a', text: 'A again', why: null, created_at: '2026-10-10' },
        { itemId: 'b', text: 'B', why: 'memory', created_at: '2026-10-11' },
      ],
    );
    expect(notes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(notes[1]).toMatchObject({ text: 'B', why: 'memory' });
  });

  it('streams on the chat role with action write and a cap for the place', () => {
    const calls: ChatRequest[] = [];
    const llm: LlmProvider = {
      stream(req) {
        calls.push(req);
        return { textStream: (async function* () {})(), model: Promise.resolve('groq:x') };
      },
      structured: () => Promise.reject(new Error('unused')),
      hasModel: () => true,
    };
    write(llm, settings, base);
    write(llm, settings, { ...base, target: 'chat' });
    expect(calls[0]).toMatchObject({ role: 'chat', action: 'write', maxOutputTokens: 800, reasoning: 'low', temperature: 0.3 });
    expect(calls[0]!.instructions).toContain(NOTHING_TO_WRITE);
    expect(calls[1]!.maxOutputTokens).toBe(350);
  });

  describe('suggestions for an empty field', () => {
    const events = [
      { title: 'Past standup', starts_at: '2026-10-14T08:00:00-04:00', ends_at: '2026-10-14T08:30:00-04:00', all_day: false },
      { title: 'Acme review', starts_at: '2026-10-15T10:00:00-04:00', ends_at: '2026-10-15T11:00:00-04:00', all_day: false },
      { title: 'Offsite', starts_at: '2026-10-30', ends_at: null, all_day: true },
    ];
    const tasks = [
      task({ text: 'Send the deck', person_name: 'Jordan Hale', due_at: '2026-10-16' }),
      task({ text: 'Share the quotes', person_name: 'Jordan Hale' }),
      task({ text: 'Call the venue', person_name: 'Casey Lin' }),
      task({ text: 'Their task', owner: 'them', person_name: 'Casey Lin' }),
    ];

    it('offers the next event this week, an update for the person owed most, and the newest snippets', () => {
      const s = writeSuggestions({ target: 'document', events, tasks, recent: 7 }, new Date(2026, 9, 14, 9, 0));
      expect(s.map((x) => x.kind)).toEqual(['event', 'task', 'snippets']);
      expect(s[0]!.label).toBe("Agenda for tomorrow's Acme review");
      expect(s[0]!.request).toMatch(/^An agenda for "Acme review" \(tomorrow, /);
      expect(s[1]).toMatchObject({ label: 'Update for Jordan on 2 open tasks', request: 'An update for Jordan Hale on what I owe them: Send the deck; Share the quotes' });
      expect(s[2]!.label).toBe('Notes from your 5 newest snippets');
    });

    it('words the event for the place, and falls back to the user\'s own tasks', () => {
      const own = [task({ text: 'Book the room' }), task({ text: 'Renew the domain' })];
      const s = writeSuggestions({ target: 'email', events: events.slice(1), tasks: own, recent: 0 }, new Date(2026, 9, 12, 9, 0));
      expect(s[0]!.label).toBe("Email about Thu's Acme review");
      expect(s[1]).toMatchObject({ kind: 'task', label: 'Status of your 2 open tasks' });
      expect(s).toHaveLength(2);
    });

    it('offers nothing with nothing ahead, owed, or saved', () => {
      expect(writeSuggestions({ target: 'chat', events: events.slice(0, 1), tasks: [], recent: 1 }, new Date(2026, 9, 14, 9, 0))).toEqual([]);
    });
  });
});
