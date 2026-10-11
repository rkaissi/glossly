import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmProvider } from '../llm/types';
import type { PersonCard } from '../people/types';
import { DEFAULT_SETTINGS } from '../settings';
import type { SelectionPayload } from '../types';
import { buildReplyPrompt, reply } from './reply';

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
  youOwe: [{ id: 'c1', owner: 'me', text: 'send the onboarding deck', due_at: '2026-10-16', status: 'open', person_id: 'p1', person_name: 'Maya Lin' }],
  theyOwe: [{ id: 'c2', owner: 'them', text: 'share the budget sheet', due_at: null, status: 'open', person_id: 'p1', person_name: 'Maya Lin' }],
  interactions: [{ id: 'i1', direction: 'outbound', text: 'Thanks, talk Friday', source_app: 'slack.exe', occurred_at: '2026-10-09T15:00:00-04:00' }],
  items: [],
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
    expect(calls[0]!.instructions).toContain('All three answer the selected message');
  });
});
