// The conversation read (decision 48): code's acceptance of the model's messages, the shared read
// with a fake model, and Tasks' per-message authors. Fictional people only.
import { describe, expect, it } from 'vitest';
import { authorFrom, buildWhoPrompt, readWho, READ_BEFORE_CHARS, type WhoRead } from '../actions/who';
import { buildPromisesPrompt, markedSelection } from '../actions/promises';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { DEFAULT_SETTINGS } from '../settings';
import type { SelectionPayload } from '../types';
import { acceptMessages, authorFirst, readAuthor, splitMessages, type MessageRow } from './conversation';
import { detectPeople, type DetectInput } from './detect';

const me = { name: 'Alex Morgan', emails: [], handles: [] };

// Discord: their question, the user's answer, their reply, all selected.
const text = [
  'what kind of job are you doing now?',
  'Alex Morgan',
  '7:34 PM',
  'another internship, this time in the city',
  'JordanZ2',
  'GEN2',
  '8:02 PM',
  'working too, at a lab supply company near home',
  "it's a startup, hopefully a good one lol",
].join('\n');
const input: DetectInput = { text, before: 'JordanZ2\nGEN2\n7:02 PM\n', after: '', source_app: 'discord.exe', window_title: 'Discord' };
const rows: MessageRow[] = [
  { author: 'JordanZ2', user: false, starts: 'what kind of job are' },
  { author: 'Alex Morgan', user: true, starts: 'another internship, this time in' },
  { author: 'JordanZ2', user: false, starts: 'working too, at a lab' },
];

describe('acceptMessages', () => {
  it('keeps messages whose starts are in the selection, in order', () => {
    const m = acceptMessages(rows, input, me)!;
    expect(m.map((x) => [x.author, x.user])).toEqual([
      ['JordanZ2', false],
      ['Alex Morgan', true],
      ['JordanZ2', false],
    ]);
    expect(m[0]!.start).toBe(0);
    expect(text.slice(m[2]!.start)).toMatch(/^working too/);
  });

  it('drops starts that are missing or out of order, and finds starts across line breaks', () => {
    const m = acceptMessages(
      [rows[2]!, rows[0]!, { author: 'JordanZ2', user: false, starts: 'never said this at all' }, { author: 'JordanZ2', user: false, starts: 'near home it’s' }],
      input,
      me,
    );
    expect(m?.length).toBe(1);
    expect(acceptMessages([{ author: 'JordanZ2', user: false, starts: 'company near home\nit\'s a startup' }], input, me)?.length).toBe(1);
    expect(acceptMessages([{ author: 'JordanZ2', user: false, starts: 'not in the text' }], input, me)).toBeNull();
  });

  it('never takes a badge or label for an author: the parser names the speaker there instead', () => {
    const m = acceptMessages(
      [
        { author: 'GEN2', user: false, starts: 'working too, at a lab' },
        { author: 'Server Tag', user: false, starts: "it's a startup, hopefully" },
      ],
      input,
      me,
    )!;
    expect(m.map((x) => x.author)).toEqual(['JordanZ2', 'JordanZ2']);
  });

  it('falls back to the parser for an author that is not in the text', () => {
    const m = acceptMessages([{ author: 'Casey Lin', user: false, starts: 'working too, at a lab' }], input, me)!;
    expect(m[0]!.author).toBe('JordanZ2');
  });

  it('checks the user with the saved name, whatever the model says', () => {
    const m = acceptMessages(
      [
        { author: 'JordanZ2', user: true, starts: 'what kind of job are' },
        { author: 'Alex Morgan', user: false, starts: 'another internship, this time in' },
      ],
      input,
      me,
    )!;
    expect(m.map((x) => x.user)).toEqual([false, true]);
    // "You" is the user in apps that label their own messages that way.
    const wa = acceptMessages([{ author: 'You', user: false, starts: 'sounds good' }], { ...input, text: 'You\nsounds good' }, me)!;
    expect(wa[0]!.user).toBe(true);
    // Without a saved name, the model's word stands.
    const anon = acceptMessages([{ author: 'Alex Morgan', user: true, starts: 'another internship, this time in' }], input, { name: '', emails: [], handles: [] })!;
    expect(anon[0]!.user).toBe(true);
  });

  it('keeps at most the last 8 messages', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Casey Lin\n9:0${i} AM\nnote number ${i} here`).join('\n');
    const m = acceptMessages(
      Array.from({ length: 10 }, (_, i) => ({ author: 'Casey Lin', user: false, starts: `note number ${i} here` })),
      { ...input, text: many },
      me,
    )!;
    expect(m.length).toBe(8);
    expect(many.slice(m[0]!.start)).toMatch(/^note number 2/);
  });
});

describe('splitMessages and the author', () => {
  const m = acceptMessages(rows, input, me)!;

  it('cuts the selection into messages without the next header', () => {
    expect(splitMessages(text, m).map((x) => x.text)).toEqual([
      'what kind of job are you doing now?',
      'another internship, this time in the city',
      "working too, at a lab supply company near home\nit's a startup, hopefully a good one lol",
    ]);
  });

  it('is the last message’s author, with details from the read’s people', () => {
    const people = [{ name: 'JordanZ2', email: 'jordan@example.com', handle: null, role: 'mentioned' as const, knownId: null }];
    expect(readAuthor(m, people)).toEqual({ author: { ...people[0], role: 'author' }, authorIsMe: false });
    expect(readAuthor(m.slice(0, 2), people)).toEqual({ author: null, authorIsMe: true });
    expect(readAuthor(null, people)).toBeNull();
  });

  it('puts the author first in the people list, adding them when missing', () => {
    const author = { name: 'JordanZ2', email: null, handle: null, role: 'author' as const, knownId: null };
    const casey = { name: 'Casey Lin', email: null, handle: null, role: 'mentioned' as const, knownId: null };
    expect(authorFirst([casey], author).map((p) => p.name)).toEqual(['JordanZ2', 'Casey Lin']);
    expect(authorFirst([casey, { ...author, role: 'mentioned' }], author).map((p) => [p.name, p.role])).toEqual([
      ['JordanZ2', 'author'],
      ['Casey Lin', 'mentioned'],
    ]);
  });
});

/** A fake Fast model that answers the read once and records each request. */
function fakeLlm(answer: unknown, hasModel = true) {
  const calls: ChatRequest[] = [];
  const llm: LlmProvider = {
    stream: () => {
      throw new Error('unused');
    },
    structured: async <T,>(req: ChatRequest) => {
      calls.push(req);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    hasModel: () => hasModel,
  };
  return { llm, calls };
}

const settings = { ...DEFAULT_SETTINGS, identity: me };

describe('readWho, the shared read', () => {
  const person = { name: 'JordanZ2', email: '', handle: '', role: '', about: 'works at a lab supply startup', relationship: 'other' as const, confidence: 0.9, evidence: 'JordanZ2' };

  it('makes one Fast call that returns messages and people, with the author first', async () => {
    const { llm, calls } = fakeLlm({ messages: rows, people: [{ ...person, name: 'Casey Lin', evidence: 'nothing' }, person] });
    const read = await readWho(llm, settings, input);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ role: 'fast', action: 'who', temperature: 0 });
    expect(calls[0]!.maxOutputTokens).toBeLessThanOrEqual(400);
    expect(read.local).toBeNull();
    expect(read.messages).toHaveLength(3);
    expect(read.people.map((p) => [p.name, p.role])).toEqual([['JordanZ2', 'author']]);
    expect(authorFrom(read, detectPeople(input, me))).toMatchObject({ author: { name: 'JordanZ2' }, authorIsMe: false });
  });

  it('sends the selection with a short window around it', () => {
    const long = { ...input, before: `${'earlier line of chat\n'.repeat(200)}JordanZ2\nGEN2\n7:02 PM\n`, after: 'later line\n'.repeat(100) };
    const prompt = buildWhoPrompt(me, long);
    const before = prompt.slice(prompt.indexOf('<before>'), prompt.indexOf('</before>'));
    expect(before.length).toBeLessThanOrEqual(READ_BEFORE_CHARS + 20);
    expect(before).toContain('JordanZ2\nGEN2\n7:02 PM');
    expect(prompt).toContain(`<selection>\n${text}\n</selection>`);
    expect(prompt.slice(prompt.indexOf('<after>')).length).toBeLessThan(360);
    // Whole lines only.
    expect(before.split('\n')[1]).toBe('earlier line of chat');
  });

  it('falls back to the text when the call fails or there is no model, with no messages', async () => {
    const failed = await readWho(fakeLlm(new Error('429')).llm, settings, input);
    expect(failed).toMatchObject({ local: 'model_failed', messages: null });
    const none = await readWho(fakeLlm(null, false).llm, settings, input);
    expect(none).toMatchObject({ local: 'no_model', messages: null });
    // The parser's author stands when the read has none.
    expect(authorFrom(none, detectPeople(input, me))).toMatchObject({ author: { name: 'JordanZ2' } });
  });
});

describe('Tasks on the read', () => {
  const read = acceptMessages(rows, input, me);

  it('marks who wrote each message when several people did', () => {
    expect(markedSelection(text, read)).toBe(
      [
        '[JordanZ2] what kind of job are you doing now?',
        '[the user] another internship, this time in the city',
        "[JordanZ2] working too, at a lab supply company near home\nit's a startup, hopefully a good one lol",
      ].join('\n'),
    );
    expect(markedSelection(text, read!.filter((m) => !m.user).slice(-1))).toBeNull();
    expect(markedSelection(text, null)).toBeNull();
  });

  it('puts the marked selection in the prompt', () => {
    const selection: SelectionPayload = {
      text,
      context_before: input.before,
      context_after: '',
      source_app: 'discord.exe',
      window_title: 'Discord',
      captured_at: '2026-10-14T10:00:00-04:00',
      method: 'uia',
      trigger: 'auto',
      is_editable: false,
    } as SelectionPayload;
    const p = buildPromisesPrompt(settings, { selection, author: null, authorIsMe: false, messages: read }, new Date(2026, 9, 14));
    expect(p).toContain('[the user] another internship');
    expect(p).toContain('each message in the selection starts with its author in brackets');
  });

  it('reads Who’s cached answer the same way for every action (one key per selection)', () => {
    const read2: WhoRead = { people: [], messages: read, local: null };
    expect(buildWhoPrompt(me, input)).toBe(buildWhoPrompt(me, { ...input }));
    expect(authorFrom(read2, detectPeople(input, me)).author?.name).toBe('JordanZ2');
  });
});

describe('email chains (Step 21)', () => {
  const chain = [
    'Jordan Hale <jordan.hale@example.com>',
    'Hi Alex, could you send the revised forecast by Friday?',
    'Jordan',
    '',
    'On Tue, Oct 6, 2026 at 3:12 PM Alex Morgan <alex.morgan@example.com> wrote:',
    'Hi Jordan, attached are the first Q4 numbers.',
    'Alex',
  ].join('\n');
  const input: DetectInput = { text: chain, before: '', after: '', source_app: 'chrome.exe', window_title: 'Re: Q4 - Mail' };
  const rows: MessageRow[] = [
    { author: 'Jordan Hale', user: false, starts: 'Hi Alex, could you' },
    { author: 'Alex Morgan', user: true, starts: 'Hi Jordan, attached are' },
  ];

  it('keeps only the newest message, above the quoted history, so the author is its sender', () => {
    const messages = acceptMessages(rows, input, me);
    expect(messages).toEqual([{ author: 'Jordan Hale', user: false, start: 0 }]);
    expect(readAuthor(messages, [])).toMatchObject({ author: { name: 'Jordan Hale' }, authorIsMe: false });
  });

  it('finds no quote in a header at the very top (a forwarded message)', () => {
    const forwarded = acceptMessages([{ author: 'Jordan Hale', user: false, starts: 'Hi Alex, could you' }], { ...input, text: `On Mon, Jordan Hale wrote:\n${chain}` }, me);
    expect(forwarded).toHaveLength(1);
  });
});
