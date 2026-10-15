import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildReplyPrompt } from '../actions/reply';
import { authorFrom } from '../actions/who';
import { detectPeople } from '../people/detect';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { DEFAULT_SETTINGS, type Identity } from '../settings';
import type { SelectionPayload, Surroundings } from '../types';
import { decideField, fieldReplyScore, fieldThread, readField, type FieldInput } from './field';
import { Router } from './router';
import { assignEmptySlots } from './slots';

const me: Identity = { name: 'Casey Lin', emails: ['casey@example.com'], handles: [] };
const router = DEFAULT_SETTINGS.router;

/** The caret at `|` (or at the end without one). */
function at(text: string, source: Surroundings['source'] = 'caret'): Surroundings {
  const caret = text.indexOf('|');
  return caret >= 0 ? { text: text.replace('|', ''), caret, source } : { text, caret: text.length, source };
}

function input(text: string, over: Partial<FieldInput> = {}): FieldInput {
  return { surroundings: at(text), editable: true, source_app: 'chrome.exe', window_title: 'Page - Google Chrome', ...over };
}

const DISCORD = input('Jordan Hale — Today at 10:42 AM\nhey are you coming to the launch review tomorrow? can you bring the deck\n', {
  source_app: 'discord.exe',
  window_title: '#general | Acme - Discord',
});
const GMAIL = input('Alex Morgan <alex@example.com>\nto me\n\nHi Casey,\nCould you send me the Q4 numbers by Friday? Thanks!\nAlex\n', {
  window_title: 'Re: Q4 numbers - casey@example.com - Gmail - Google Chrome',
});
const OUTLOOK = input('|\n\nFrom: Alex Morgan <alex@example.com>\nSent: Tuesday, October 13, 2026 9:12 AM\nTo: Casey Lin\nSubject: Lunch\n\nAre you free for lunch on Thursday? There is a new place near the office.', {
  source_app: 'olk.exe',
  window_title: 'Lunch - Message (HTML)',
});
const NOTES = input('Ideas for the garden this spring: move the tomatoes to the south bed, add a second compost bin, and try growing beans along the fence.\n', {
  source_app: 'notepad.exe',
  window_title: 'garden.txt - Notepad',
});

describe('fieldThread', () => {
  it('takes the messages before the caret, or a quoted message after it when little is before', () => {
    expect(fieldThread(DISCORD.surroundings)?.text).toMatch(/^Jordan Hale/);
    const outlook = fieldThread(OUTLOOK.surroundings);
    expect(outlook?.text).toMatch(/^From: Alex Morgan/);
    expect(outlook?.before).toBe('');
  });

  it('in a chat, answers the last speaker’s messages and keeps the earlier ones as context', () => {
    const t = fieldThread(at('Maya Chen — Today at 10:31 AM\nmorning all, the build is green again after the fix\nJordan Hale — Today at 10:42 AM\nare you coming to the launch review tomorrow? can you bring the deck\n'))!;
    expect(t.text).toMatch(/^Jordan Hale/);
    expect(t.text).not.toContain('build is green');
    expect(t.before).toContain('Maya Chen');
  });

  it('answers the quoted email right under the box, whatever page text sits above it', () => {
    const chrome = 'Lunch\nReply  Reply all  Forward  Discard  Send\nTo: Alex Morgan\nSubject: RE: Lunch\n';
    const t = fieldThread(at(`${chrome}|\n\n${OUTLOOK.surroundings!.text.trim()}`))!;
    expect(t.text).toMatch(/^From: Alex Morgan/);
    expect(t.before).toBe('');
    // A draft the user typed far above a quote further down is still answered from before the caret.
    const far = fieldThread(at(`${chrome}|${'\n'.repeat(2)}${'Notes from the meeting about the venue. '.repeat(20)}\n\n${OUTLOOK.surroundings!.text.trim()}`))!;
    expect(far.text).not.toMatch(/^From:/);
  });

  it('names the quoted email’s sender, not the sender of the older email it quotes', () => {
    const older = '\n\nFrom: Jordan Hale <jordan@example.com>\nSent: Monday, October 12, 2026 4:02 PM\nTo: Alex Morgan\nSubject: Lunch\n\nShould we invite Casey to lunch this week?';
    const t = fieldThread(at(`|\n\n${OUTLOOK.surroundings!.text.trim()}${older}`))!;
    expect(t.text).toMatch(/^From: Alex Morgan/);
    expect(t.text).not.toContain('Jordan');
    expect(t.after).toMatch(/From: Jordan Hale/);
    // How startReply finds the author: the local parser, unless the conversation read names one.
    const sel = { text: t.text, before: t.before, after: t.after, source_app: 'olk.exe', window_title: 'Lunch - Message (HTML)' };
    expect(authorFrom(null, detectPeople(sel, me)).author).toMatchObject({ name: 'Alex Morgan', email: 'alex@example.com' });
  });

  it('needs a caret in a field and enough text to answer', () => {
    expect(fieldThread(at('Jordan Hale — Today at 10:42 AM\nare you coming to the review tomorrow?', 'visible'))).toBeNull();
    expect(fieldThread(at('ok thanks'))).toBeNull();
    expect(fieldThread(null)).toBeNull();
  });
});

describe('readField', () => {
  it('scores chat composers and email replies as reply boxes', () => {
    for (const f of [DISCORD, GMAIL, OUTLOOK]) expect(readField(f, [], me)!.rules).toBeGreaterThan(0.5);
  });

  it('does not offer Reply in a document, where nothing reads like a conversation', () => {
    const notes = readField(NOTES, [], me)!;
    expect(notes.rules).toBeLessThan(router.moreThreshold);
    expect(notes.backed).toBe(false);
  });

  it('blocks automated mail and the user’s own last message, and needs a field that takes text', () => {
    const shipped = input('Northwind Store <no-reply@example.com>\nYour order has shipped! Track your package with tracking number 1Z999.\n', {
      window_title: 'Your order has shipped - casey@example.com - Gmail',
    });
    expect(readField(shipped, [], me)!.blocked).toBe(true);
    const mine = input('Jordan Hale — Today at 10:40 AM\nare you coming tomorrow?\nCasey Lin — Today at 10:42 AM\nyes, see you there at the review\n', {
      source_app: 'discord.exe',
      window_title: '#general | Acme - Discord',
    });
    expect(readField(mine, [], me)!.blocked).toBe(true);
    expect(readField({ ...DISCORD, editable: false }, [], me)).toBeNull();
  });
});

describe('fieldReplyScore', () => {
  it('uses the model, capped without anything to back it, and never where nobody is answered', () => {
    const discord = readField(DISCORD, [], me);
    expect(fieldReplyScore(discord, 0.9)).toBe(0.9);
    expect(fieldReplyScore(discord, null)).toBe(discord!.rules);
    expect(fieldReplyScore(readField(NOTES, [], me), 0.9)).toBe(0.45);
    expect(fieldReplyScore({ ...discord!, blocked: true }, 0.9)).toBe(0);
    expect(fieldReplyScore(null, 0.9)).toBe(0);
  });
});

describe('the empty bar', () => {
  it('leads with Reply in a reply box, ahead of Search, and keeps a maybe under More', () => {
    const sure = assignEmptySlots({ editable: true, recent: 3, summaryModel: true, reply: 0.7 }, router);
    expect([sure.slot3?.action, sure.slot4?.action]).toEqual(['reply', 'search']);
    expect(sure.more.map((m) => m.action)).toEqual(['paste_list', 'paste_summary']);
    const maybe = assignEmptySlots({ editable: true, recent: 0, summaryModel: true, reply: 0.35 }, router);
    expect([maybe.slot3?.action, maybe.slot4, maybe.more.map((m) => m.action)]).toEqual(['search', null, ['reply']]);
    const none = assignEmptySlots({ editable: true, recent: 0, summaryModel: true }, router);
    expect(none.more).toEqual([]);
  });
});

describe('Router.routeField', () => {
  const deps = (privacy: 'all' | 'local', field: (i: FieldInput) => Promise<number>) => ({
    decision: null,
    field,
    settings: () => ({ router, privacy }),
    collections: () => ['Notes'],
    identity: () => me,
  });

  it('asks the model when there is someone to answer, and goes by rules under Local only', async () => {
    let calls = 0;
    const model = async () => (calls++, 0.2);
    const r = await new Router(deps('all', model)).routeField(DISCORD);
    expect([r.score, r.model, r.fallback, calls]).toEqual([0.2, 0.2, null, 1]);
    const local = new Router(deps('local', model));
    expect(local.fieldWillCallModel(DISCORD)).toBe(false);
    const l = await local.routeField(DISCORD);
    expect([l.fallback, l.score, calls]).toEqual(['local_only', readField(DISCORD, [], me)!.rules, 1]);
  });

  it('skips the call when the rules found nothing to answer, and falls back on an error', async () => {
    let calls = 0;
    const r = new Router(deps('all', async () => (calls++, 0.9)));
    expect(r.fieldWillCallModel(input('ok thanks'))).toBe(false);
    expect((await r.routeField(input('ok thanks'))).score).toBe(0);
    expect(calls).toBe(0);
    const failing = await new Router(deps('all', () => Promise.reject(new Error('boom')))).routeField(DISCORD);
    expect([failing.fallback, failing.score]).toEqual(['error', readField(DISCORD, [], me)!.rules]);
  });
});

describe('decideField', () => {
  it('calls the decision role with the text around the caret', async () => {
    const calls: ChatRequest[] = [];
    const llm: LlmProvider = {
      stream: () => {
        throw new Error('unused');
      },
      structured: async <T>(req: ChatRequest, schema: z.ZodType<T>) => (calls.push(req), schema.parse({ reply_box: 0.85 })),
      hasModel: () => true,
    };
    expect(await decideField(llm, OUTLOOK)).toBe(0.85);
    expect(calls[0]).toMatchObject({ role: 'decision', action: 'router', temperature: 0 });
    expect(calls[0]!.prompt).toContain('<before_caret>\n\n</before_caret>\n<after_caret>\n\n\nFrom: Alex Morgan');
  });
});

describe('Reply from the reply box', () => {
  it('tells the model the messages are the text around the box', () => {
    const t = fieldThread(DISCORD.surroundings)!;
    const selection: SelectionPayload = {
      text: t.text,
      context_before: t.before,
      context_after: '',
      source_app: 'discord.exe',
      window_title: '#general | Acme - Discord',
      captured_at: '2026-10-14T10:43:00+00:00',
      method: 'uia',
      trigger: 'hotkey',
      is_editable: false,
      foreground_handle: 1,
    };
    const base = { selection, author: null, authorIsMe: false, person: null, voice: [] };
    expect(buildReplyPrompt({ identity: me }, { ...base, field: true })).toContain('## Where the user is');
    expect(buildReplyPrompt({ identity: me }, base)).not.toContain('## Where the user is');
  });
});
