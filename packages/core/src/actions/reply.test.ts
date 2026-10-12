import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmProvider } from '../llm/types';
import type { PersonCard } from '../people/types';
import { DEFAULT_SETTINGS } from '../settings';
import type { SelectionPayload } from '../types';
import { buildReplyPrompt, markOwnHeaders, messagesToAnswer, reply } from './reply';
import { detectPeople } from '../people/detect';
import { authorFrom, readWho } from './who';

const settings = { ...DEFAULT_SETTINGS, identity: { name: 'Alex Morgan', emails: [], handles: ['alexm'] } };
const now = new Date(2026, 9, 14, 10, 0);

const selection: SelectionPayload = {
  text: 'Can you send me the slides before Friday?',
  context_before: 'Maya Lin  9:41 AM\n',
  context_after: '\nDaniel Park  9:45 AM\nsame here please',
  source_app: 'slack.exe',
  window_title: 'Maya Lin (DM) | Acme - Slack',
  captured_at: '2026-10-14T10:00:00-04:00',
  method: 'uia',
  trigger: 'auto',
  is_editable: false,
  foreground_handle: 1,
};

const maya: PersonCard = {
  id: 'p1',
  name: 'Maya Lin',
  relationship: 'colleague',
  note: 'PM on the Acme account',
  aliases: [],
  youOwe: [{ id: 'c1', owner: 'me', text: 'send the onboarding deck', due_at: '2026-10-16', status: 'open', completed_at: null, person_id: 'p1', person_name: 'Maya Lin' }],
  theyOwe: [{ id: 'c2', owner: 'them', text: 'share the budget sheet', due_at: null, status: 'open', completed_at: null, person_id: 'p1', person_name: 'Maya Lin' }],
  interactions: [{ id: 'i1', direction: 'outbound', text: 'Thanks, talk Friday', source_app: 'slack.exe', occurred_at: '2026-10-09T15:00:00-04:00' }],
  items: [],
  events: [],
  created_at: '2026-10-01T10:00:00-04:00',
};

const author = { name: 'Maya Lin', email: null, handle: null, role: 'author' as const, knownId: null };

describe('Reply', () => {
  it('puts the user, the person record, voice samples, and the thread in the prompt', () => {
    const p = buildReplyPrompt(settings, { selection, author, authorIsMe: false, person: maya, voice: ['sounds good!! will do', 'yep on it'] }, now);
    expect(p).toContain('## The user\nAlex Morgan (also: @alexm)');
    expect(p).toContain('## Replying to\nMaya Lin');
    expect(p).toContain('Relationship to the user: colleague');
    expect(p).toContain('How the user knows them: PM on the Acme account');
    expect(p).toContain('The user owes them:\n- send the onboarding deck (due Fri, Oct 16)');
    expect(p).toContain('They owe the user:\n- share the budget sheet');
    expect(p).toContain('- Fri, Oct 9, from the user: Thanks, talk Friday');
    expect(p).toContain('<sample>\nsounds good!! will do\n</sample>');
    expect(p).toContain('## App\nslack.exe, "Maya Lin (DM) | Acme - Slack"');
    expect(p).toContain('Maya Lin  9:41 AM\n[REPLY TO THIS]');
    // A later message isn't part of the thread (decision 52).
    expect(p).not.toContain('Daniel Park');
  });

  it('handles no person record, no samples, and the user as the author', () => {
    const p = buildReplyPrompt(settings, { selection, author: null, authorIsMe: true, person: null, voice: [] }, now);
    expect(p).toContain('The user wrote the selected message; draft a follow-up');
    expect(p).not.toContain('What you know about');
    expect(p).toContain('None yet. Keep it natural and brief.');
    expect(p).not.toContain('What the user tends to pick');
  });

  it('adds what the user tends to pick and the style notes', () => {
    const p = buildReplyPrompt(
      settings,
      {
        selection,
        author,
        authorIsMe: false,
        person: null,
        voice: [],
        preferences: ['Keeps replies short (8 of the last 10 picks in chat)'],
        notes: ["Drops 'Hope you're well'"],
      },
      now,
    );
    expect(p).toContain('## What the user tends to pick\n- Keeps replies short (8 of the last 10 picks in chat)');
    expect(p).toContain("## Notes on how the user writes\n- Drops 'Hope you're well'");
  });

  it('adds the drafts the user passed on and what they want instead', () => {
    const p = buildReplyPrompt(
      settings,
      {
        selection,
        author,
        authorIsMe: false,
        person: null,
        voice: [],
        redo: { passedOn: [{ intent: 'Yes, Friday', text: 'Sure, I will send them Friday.' }], asks: ['shorter', 'different'], note: "say I'm out until Monday" },
      },
      now,
    );
    expect(p).toContain('## Drafts the user passed on\n<passed>\nYes, Friday: Sure, I will send them Friday.\n</passed>');
    expect(p).toContain("## What the user wants instead\n- Shorter than these.\n- Different answers: do not repeat the intents of these drafts.\n- In their words: \"say I'm out until Monday\"");
    expect(buildReplyPrompt(settings, { selection, author, authorIsMe: false, person: null, voice: [] }, now)).not.toContain('passed on');
  });

  it('streams on the chat role with action reply', () => {
    const calls: ChatRequest[] = [];
    const llm: LlmProvider = {
      stream(req) {
        calls.push(req);
        return { textStream: (async function* () {})(), model: Promise.resolve('groq:x') };
      },
      structured: () => Promise.reject(new Error('unused')),
      hasModel: () => true,
    };
    reply(llm, settings, { selection, author, authorIsMe: false, person: null, voice: [] });
    expect(calls[0]).toMatchObject({ role: 'chat', action: 'reply' });
    expect(calls[0]!.instructions).toContain('Write exactly 3 drafts');
    expect(calls[0]!.instructions).toContain('Follow every line in all three drafts');
    expect(calls[0]!.instructions).not.toContain('deliberately differs');
    expect(calls[0]!.instructions).toContain('Answer only "The message to answer"');
    // Output cap by channel, with low reasoning so a reasoning model doesn't spend it (decision 48).
    expect(calls[0]).toMatchObject({ maxOutputTokens: 900, reasoning: 'low' });
    reply(llm, settings, { selection, author, authorIsMe: false, person: null, voice: [], channel: 'work_chat' });
    reply(llm, settings, { selection, author, authorIsMe: false, person: null, voice: [], channel: 'email' });
    expect(calls.slice(1).map((c) => c.maxOutputTokens)).toEqual([450, 900]);
  });

  it('keeps 3 voice samples of at most 300 characters, and stable parts before the message', () => {
    const long = 'x'.repeat(500);
    const p = buildReplyPrompt(settings, { selection, author, authorIsMe: false, person: maya, voice: ['one', 'two', 'three', 'four', long] }, now);
    expect(p).toContain('<sample>\nthree\n</sample>');
    expect(p).not.toContain('<sample>\nfour');
    const q = buildReplyPrompt(settings, { selection, author, authorIsMe: false, person: null, voice: [long] }, now);
    expect(q).toContain(`${'x'.repeat(300)}…`);
    expect(q).not.toContain('x'.repeat(301));
    const order = ['## The user', '## Voice samples', '## What you know about', '## Replying to', '## App', '## Today', '## The message to answer', '## Thread'].map((h) => p.indexOf(h));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
  });

  it('leaves out the messages after the selected one, the user’s answer among them (decision 52)', () => {
    const me = { name: 'Alex Morgan', emails: [], handles: [] };
    const sel: SelectionPayload = {
      ...selection,
      source_app: 'discord.exe',
      window_title: 'Discord',
      context_before: 'Jordan\nYesterday at 3:03 PM\nhaha\nOctober 11, 2026\nJordan\n5:11 PM\n',
      text: 'know anyone still looking for a room near campus next term?',
      context_after: '\nAlex\n7:34 PM\nnot that I know of\nill tell you if I hear of someone\n',
    };
    const p = buildReplyPrompt({ ...DEFAULT_SETTINGS, identity: me }, { selection: sel, author: { ...author, name: 'Jordan' }, authorIsMe: false, person: null, voice: [] }, now);
    const thread = p.slice(p.indexOf('<thread>'), p.indexOf('</thread>'));
    expect(p).toContain('## Replying to\nJordan');
    expect(thread).toContain('5:11 PM\n[REPLY TO THIS]');
    expect(thread).not.toContain('not that I know of');
    expect(thread).not.toContain('ill tell you');
    // The rest of the selected message after the selection stays.
    const cut = buildReplyPrompt({ ...DEFAULT_SETTINGS, identity: me }, { selection: { ...sel, text: 'know anyone still looking', context_after: ' for a room near campus?\nAlex\n7:34 PM\nnope\n' }, author, authorIsMe: false, person: null, voice: [] }, now);
    expect(cut).toContain('[REPLY TO THIS] for a room near campus?');
    expect(cut).not.toContain('nope');
  });

  it('sends about 2,000 characters of the thread before the selection and 300 after', () => {
    const before = 'Maya Lin  9:00 AM\nearlier line of the chat\n'.repeat(120);
    const after = '\nlater line'.repeat(100);
    const p = buildReplyPrompt(settings, { selection: { ...selection, context_before: before, context_after: after }, author, authorIsMe: false, person: null, voice: [] }, now);
    const thread = p.slice(p.indexOf('<thread>'), p.indexOf('</thread>'));
    expect(thread.length).toBeLessThan(2000 + 300 + 100);
    expect(thread.split('[REPLY TO THIS]')[0]!.length).toBeGreaterThan(1500);
  });
});

describe('Reply answers only the other person (decision 47)', () => {
  const me = { name: 'Alex Morgan', emails: [], handles: [] };
  // Discord's layout: name, an optional server tag, then the time, each on its own line.
  const before = ['JordanZ2', 'Server Tag: GEN2', '7:02 PM', 'what kind of job are you doing now?', 'Alex', '7:34 PM', 'another internship, this time in the city', 'are you in school this term or working too?', ''].join('\n');
  const theirs = ['JordanZ2', 'Server Tag: GEN2', '8:02 PM', 'working too, at a lab supply company near home', "it's a startup, hopefully a good one lol"].join('\n');

  it('finds the real author past the server tag, never "Server Tag"', () => {
    const p = buildReplyPrompt({ ...DEFAULT_SETTINGS, identity: me }, {
      selection: { ...selection, source_app: 'discord.exe', window_title: 'Discord', context_before: before, text: theirs.split('\n').slice(3).join('\n'), context_after: '' },
      author: null,
      authorIsMe: false,
      person: null,
      voice: [],
    });
    expect(p).not.toContain('Server Tag  (the user)');
    expect(p).toContain('Alex  (the user)');
    expect(p).not.toContain('JordanZ2  (the user)');
  });

  it('drops the user’s own messages from a selection that holds both', () => {
    const both = ['Alex', '7:34 PM', 'are you in school this term?', theirs].join('\n');
    const r = messagesToAnswer(both, '', me);
    expect(r?.droppedEarlier).toBe(true);
    expect(r?.text).toContain('working too');
    expect(r?.text).not.toContain('school this term');
    // Lines before the first header belong to whoever spoke last before the selection.
    expect(messagesToAnswer('are you in school this term?', 'Alex\n7:34 PM\n', me)).toBeNull();
    expect(messagesToAnswer('working too', before.replace(/Alex\n7:34 PM[\s\S]*$/, ''), me)?.droppedEarlier).toBe(false);
  });

  it('answers only what they wrote after the user’s last message (decision 48)', () => {
    // Their question, the user's answer, their reply: only the reply is answered.
    const convo = ['JordanZ2', 'GEN2', '7:02 PM', 'what kind of job are you doing now?', 'Alex Morgan', '7:34 PM', 'another internship, this time in the city', theirs].join('\n');
    const r = messagesToAnswer(convo, '', me);
    expect(r?.droppedEarlier).toBe(true);
    expect(r?.text).toContain('hopefully a good one');
    expect(r?.text).not.toContain('what kind of job');
    expect(r?.text).not.toContain('internship');
    // Only theirs: all of it.
    const only = messagesToAnswer(['what kind of job are you doing now?', theirs].join('\n'), 'JordanZ2\nGEN2\n7:02 PM\n', me);
    expect(only?.droppedEarlier).toBe(false);
    expect(only?.text).toContain('what kind of job');
    // Ending with the user's own message: a follow-up, nothing to answer.
    expect(messagesToAnswer([theirs, 'Alex', '8:10 PM', 'nice, good luck'].join('\n'), '', me)).toBeNull();
  });

  it('marks the user’s headers in the thread', () => {
    expect(markOwnHeaders('Alex Morgan  9:41 AM\nhi\nJordan Hale  9:42 AM\nhey', me)).toBe('Alex Morgan  9:41 AM  (the user)\nhi\nJordan Hale  9:42 AM\nhey');
  });
});

describe('Reply’s author on Discord (decision 47)', () => {
  it('is the sender, not the server tag, and not the user', () => {
    const me = { name: 'Alex Morgan', emails: [], handles: [] };
    const before = ['Alex', '7:34 PM', 'are you working this term?', 'JordanZ2', 'Server Tag: GEN2', '8:02 PM', ''].join('\n');
    const d = detectPeople({ text: 'working too, at a lab supply company', before, after: '', source_app: 'discord.exe', window_title: 'Discord' }, me);
    expect(d.author?.name).toBe('JordanZ2');
    expect(d.authorIsMe).toBe(false);
    const inline = detectPeople({ text: 'hey', before: 'JordanZ2 Server Tag: GEN2 8:02 PM\n', after: '', source_app: 'discord.exe', window_title: 'Discord' }, me);
    expect(inline.author?.name).toBe('JordanZ2');
  });
});

describe('Reply on the conversation read (decision 48)', () => {
  const me = { name: 'Alex Morgan', emails: [], handles: [] };
  const s2 = { ...DEFAULT_SETTINGS, identity: me };
  // Their question, the user's answer, their reply: all selected in a fictional Discord DM.
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
  const sel: SelectionPayload = { ...selection, source_app: 'discord.exe', window_title: 'Discord', context_before: 'JordanZ2\nGEN2\n7:02 PM\n', text, context_after: '' };
  const input = { text, before: sel.context_before, after: '', source_app: 'discord.exe', window_title: 'Discord' };
  const fast = (answer: unknown): LlmProvider => ({
    stream: () => {
      throw new Error('unused');
    },
    structured: async <T,>() => {
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    hasModel: () => true,
  });
  const rows = [
    { author: 'JordanZ2', user: false, starts: 'what kind of job are' },
    { author: 'Alex Morgan', user: true, starts: 'another internship, this time in' },
    { author: 'JordanZ2', user: false, starts: 'working too, at a lab' },
  ];

  const promptFor = async (answer: unknown) => {
    const read = await readWho(fast(answer), s2, input);
    const by = authorFrom(read, detectPeople(input, me));
    return { by, p: buildReplyPrompt(s2, { selection: sel, ...by, person: null, voice: [], messages: read.messages }, now) };
  };

  it('replies to the other person, answering only what came after the user’s message', async () => {
    const { by, p } = await promptFor({ messages: rows, people: [] });
    expect(by).toMatchObject({ author: { name: 'JordanZ2' }, authorIsMe: false });
    expect(p).toContain('## Replying to\nJordanZ2');
    const message = p.slice(p.indexOf('<message>'), p.indexOf('</message>'));
    expect(message).toContain('working too, at a lab supply company');
    expect(message).toContain('hopefully a good one lol');
    expect(message).not.toContain('what kind of job');
    expect(message).not.toContain('internship');
    expect(p).toContain('earlier messages');
    // The thread holds the earlier part, the user's header marked, and the marker where the target sits.
    const thread = p.slice(p.indexOf('<thread>'), p.indexOf('</thread>'));
    expect(thread).toContain('what kind of job are you doing now?');
    expect(thread).toContain('Alex Morgan  (the user)');
    expect(thread).toContain('another internship, this time in the city\n[REPLY TO THIS]');
    expect(thread).not.toContain('working too');
  });

  it('writes a follow-up when the user wrote last', async () => {
    const { by, p } = await promptFor({ messages: rows.slice(0, 2), people: [] });
    expect(by.authorIsMe).toBe(true);
    expect(p).toContain('The user wrote the selected message; draft a follow-up');
  });

  it('falls back to the header parser when the read fails, with the same recipient and target', async () => {
    const { by, p } = await promptFor(new Error('rate limited'));
    expect(by.author?.name).toBe('JordanZ2');
    const message = p.slice(p.indexOf('<message>'), p.indexOf('</message>'));
    expect(message).toContain('working too');
    expect(message).not.toContain('internship');
  });
});

describe('what Reply is told to answer (decision 52)', () => {
  it('says the target is the other person’s last highlighted message, never the user’s or a newer one', () => {
    const p = buildReplyPrompt(settings, { selection, author, authorIsMe: false, person: null, voice: [] }, now);
    expect(p).toContain("## The message to answer\nThe other person's last message (or last few in a row) in what the user highlighted. Reply to this, not to anything newer in the thread.\n<message>");
    const own = buildReplyPrompt(settings, { selection, author: null, authorIsMe: true, person: null, voice: [] }, now);
    expect(own).toContain('## The message to answer\nThe user highlighted their own message; write a follow-up to it.');
  });
});
