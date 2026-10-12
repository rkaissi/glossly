import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmProvider } from '../llm/types';
import type { PersonCard } from '../people/types';
import { DEFAULT_SETTINGS } from '../settings';
import type { SelectionPayload } from '../types';
import { buildReplyPrompt, markOwnHeaders, messagesToAnswer, reply } from './reply';
import { detectPeople } from '../people/detect';

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
    expect(p).toContain('Maya Lin  9:41 AM\n[SELECTION]\nDaniel Park');
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

  it('answers only what they wrote after the user’s last message (Step 20.4)', () => {
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
