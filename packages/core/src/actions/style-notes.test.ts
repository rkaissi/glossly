import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { acceptStyleNotes, buildStyleNotesPrompt, writeStyleNotes, type EditedPair } from './style-notes';

// Fictional edits: two in email (pairs 1 and 2), three in a messaging app (3 to 5), numbered in that order.
const pairs: EditedPair[] = [
  { original: 'Hi Maya,\n\nThanks so much for the update. I will review it today.\n\nBest,\nAlex', text: 'thanks, will review today', channel: 'email' },
  { original: 'Hi Jordan,\n\nThat works for me. See you on Friday.\n\nBest,\nAlex', text: 'works for me, see you friday', channel: 'email' },
  { original: 'Sounds great! I will be there.', text: 'sounds good, ill be there', channel: 'messaging' },
  { original: 'Sure, I’m around on Saturday afternoon.', text: 'sure Im around saturday', channel: 'messaging' },
  { original: 'Unfortunately I won’t be able to join the hike.', text: 'gonna skip the hike tbh, dont wait up', channel: 'messaging' },
];
const none = { keep: false as const };

describe('style notes (decision 49)', () => {
  it('groups pairs by platform, with what code measured, the picks, and the current notes', () => {
    const p = buildStyleNotesPrompt(pairs, [{ text: 'Keeps replies short', channel: 'messaging' }], { messaging: ['Keeps replies short (5 of the last 6 picks in messaging apps)'] }, ['Uses emoji']);
    expect(p.indexOf('## Edited drafts: Email')).toBeLessThan(p.indexOf('## Edited drafts: Messaging apps'));
    expect(p).toMatch(/<pair n="1">\n<draft>\nHi Maya/);
    expect(p).toMatch(/<pair n="3">\n<draft>\nSounds great!/);
    expect(p).toMatch(/<measured>words 15 → 4; .*Writes in lowercase.*<\/measured>/);
    expect(p).toContain('Drops apostrophes (dont, im)');
    expect(p).toContain('## Current notes\n- [messaging] Keeps replies short');
    expect(p).toContain('Messaging apps:\n- Keeps replies short (5 of the last 6 picks in messaging apps)');
    expect(p).toContain('## Notes the user removed\n- Uses emoji');
  });

  it('keeps everything as it is when the model says keep, or writes the same notes', () => {
    const current = [{ text: 'Writes in lowercase', channel: 'messaging' as const }];
    expect(acceptStyleNotes({ keep: true, notes: [] }, pairs, current, [])).toEqual({ keep: true });
    const same = acceptStyleNotes({ ...none, notes: [{ aspect: 'capitalization', note: 'Writes in lowercase', where: 'messaging', pairs: [] }] }, pairs, current, []);
    expect(same).toEqual({ keep: true });
  });

  it('needs two pairs from a new note’s platform; a current note may stay without new pairs', () => {
    const r = acceptStyleNotes(
      {
        ...none,
        notes: [
          { aspect: 'formality', note: 'Writes casually with slang', where: 'messaging', pairs: [3, 5] },
          // Email pairs don't back a messaging note.
          { aspect: 'greeting', note: 'Drops the greeting', where: 'messaging', pairs: [1, 2] },
          { aspect: 'greeting', note: 'Drops the greeting', where: 'email', pairs: [1, 2] },
          { aspect: 'punctuation', note: 'Drops apostrophes', where: 'messaging', pairs: [4] },
          { aspect: 'length', note: 'Keeps replies short', where: 'messaging', pairs: [] },
        ],
      },
      pairs,
      [{ text: 'Keeps replies short', channel: 'messaging' }],
      [],
    );
    expect(r).toEqual({
      keep: false,
      notes: [
        { text: 'Writes casually with slang', channel: 'messaging' },
        { text: 'Drops the greeting', channel: 'email' },
        { text: 'Keeps replies short', channel: 'messaging' },
      ],
    });
  });

  it('drops removed notes, repeats, and a crowded aspect', () => {
    const r = acceptStyleNotes(
      {
        ...none,
        notes: [
          { aspect: 'capitalization', note: 'Writes in lowercase', where: 'everywhere', pairs: [1, 3, 4] },
          { aspect: 'emoji', note: 'Uses emoji', where: 'messaging', pairs: [3, 4] },
          { aspect: 'capitalization', note: 'writes in lowercase.', where: 'messaging', pairs: [3, 4] },
          { aspect: 'punctuation', note: 'Drops the final period', where: 'messaging', pairs: [3, 4] },
          { aspect: 'punctuation', note: 'Fewer commas', where: 'messaging', pairs: [4, 5] },
          { aspect: 'punctuation', note: 'No exclamation marks', where: 'messaging', pairs: [4, 5] },
        ],
      },
      pairs,
      [],
      ['Uses emoji'],
    );
    expect(r).toEqual({
      keep: false,
      notes: [
        { text: 'Writes in lowercase', channel: null },
        { text: 'Drops the final period', channel: 'messaging' },
        { text: 'Fewer commas', channel: 'messaging' },
      ],
    });
  });

  it('counts what the user asked Write here for (decision 81): a request made twice backs a note, and only requests back what they include', () => {
    const requests = [
      { kind: 'change' as const, text: 'no em dashes', channel: 'document' as const },
      { kind: 'request' as const, text: 'status for Acme, mention the launch date', channel: 'email' as const },
      { kind: 'change' as const, text: 'drop the dashes', channel: 'document' as const },
      { kind: 'request' as const, text: 'update for Jordan with the launch date', channel: 'email' as const },
    ];
    const p = buildStyleNotesPrompt(pairs, [], {}, [], requests);
    expect(p).toContain('## What the user asked Write here for (newest first)\n<request n="1" kind="change" where="document">no em dashes</request>');
    const out = acceptStyleNotes(
      {
        keep: false,
        notes: [
          { aspect: 'punctuation', note: 'Avoids dashes', where: 'document', pairs: [], requests: [1, 3] },
          { aspect: 'includes', note: 'Status emails mention the launch date', where: 'email', pairs: [], requests: [2, 4] },
          // One pair and one request from email: enough together for a style note.
          { aspect: 'length', note: 'Short emails', where: 'email', pairs: [1], requests: [2] },
          // An includes note with pairs alone is never from requests: dropped.
          { aspect: 'includes', note: 'Mentions Friday', where: 'email', pairs: [1, 2], requests: [] },
          // A document request doesn't back an email note.
          { aspect: 'emoji', note: 'No emoji', where: 'email', pairs: [1], requests: [3] },
        ],
      },
      pairs,
      [],
      [],
      requests,
    );
    expect(out).toEqual({
      keep: false,
      notes: [
        { text: 'Avoids dashes', channel: 'document' },
        { text: 'Status emails mention the launch date', channel: 'email' },
        { text: 'Short emails', channel: 'email' },
      ],
    });
  });

  it('asks the Fast role at temperature 0, and skips the call with fewer than two pairs', async () => {
    const calls: ChatRequest[] = [];
    const llm: LlmProvider = {
      stream: () => {
        throw new Error('unused');
      },
      structured: async <T>(req: ChatRequest) => {
        calls.push(req);
        return { keep: false, notes: [{ aspect: 'length', note: 'Cuts to one line', where: 'messaging', pairs: [3, 4] }] } as T;
      },
      hasModel: () => true,
    };
    const input = { current: [], picks: {}, removed: [] };
    expect(await writeStyleNotes(llm, { ...input, pairs: pairs.slice(0, 1) })).toEqual({ keep: true });
    expect(calls).toHaveLength(0);
    expect(await writeStyleNotes(llm, { ...input, pairs })).toEqual({ keep: false, notes: [{ text: 'Cuts to one line', channel: 'messaging' }] });
    expect(calls[0]).toMatchObject({ role: 'fast', action: 'style_notes', temperature: 0 });
  });
});
