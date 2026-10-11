import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { DEFAULT_COLLECTIONS, DEFAULT_SETTINGS } from '../settings';
import { extractFeatures } from './features';
import { formatDecisionPrompt, LlmStructuredDecision } from './llm-decision';
import { Router } from './router';
import { decideByRules, ruleCollection } from './rules';
import { assignSlots, rankSlots, scoreActions } from './slots';
import type { DecisionProvider, Decisions, SelectionContext } from './types';

const collections = [...DEFAULT_COLLECTIONS];

function ctx(text: string, over: Partial<SelectionContext> = {}): SelectionContext {
  return { text, context_before: '', context_after: '', source_app: 'chrome.exe', window_title: 'Page - Google Chrome', is_editable: false, ...over };
}

const rules = (c: SelectionContext, people = [] as Parameters<typeof extractFeatures>[1]) =>
  decideByRules({ context: c, features: extractFeatures(c, people), collections });

const THREAD = 'Sam Lee  10:42 AM\nhey, can you send the deck by Friday?\nPriya Shah  10:44 AM\nsure, will do';
const TABLE = 'Region\tQ1\tQ2\nNorth\t120\t140\nSouth\t90\t95\nWest\t70\t88';
const CODE = 'export function add(a: number, b: number) {\n  return a + b;\n}';
const ARTICLE = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + '.';

describe('extractFeatures', () => {
  it('finds emails, handles, phones, and name pairs, skipping common capitalized words', () => {
    const f = extractFeatures(ctx('Thank You Sam Lee, mail sam@acme.io or ping @sam_lee, call 555-123-4567. Hello World'));
    expect(f.emails).toEqual(['sam@acme.io']);
    expect(f.handles).toEqual(['sam_lee']);
    expect(f.phones).toEqual(['555-123-4567']);
    expect(f.namePairs).toEqual(['Sam Lee']);
  });

  it('matches known people by name or alias, ignoring very short aliases', () => {
    const people = [
      { id: 'p1', name: 'Sam Lee', aliases: ['@samlee'] },
      { id: 'p2', name: 'Jo', aliases: ['Jo'] },
      { id: 'p3', name: 'Priya Shah', aliases: [] },
    ];
    expect(extractFeatures(ctx('thanks @samlee and Jo, see priya shah'), people).knownPeople).toEqual(['p1', 'p3']);
  });

  it('detects table shape, chat lines, commitments, questions, and code', () => {
    expect(extractFeatures(ctx(TABLE)).tableShape).toBe(true);
    const thread = extractFeatures(ctx(THREAD));
    expect(thread.chatLines).toBe(2);
    expect(thread.commitmentPhrases).toEqual(expect.arrayContaining(['can you', 'by friday', 'will do']));
    expect(thread.hasDateWord).toBe(true);
    expect(extractFeatures(ctx('Is this ready?')).endsWithQuestion).toBe(true);
    expect(extractFeatures(ctx(CODE)).codeScore).toBeGreaterThanOrEqual(0.45);
    expect(extractFeatures(ctx('hi', { source_app: 'slack.exe' })).messengerApp).toBe(true);
    expect(extractFeatures(ctx('hi', { source_app: 'chrome.exe', window_title: 'Inbox - Gmail' })).messengerApp).toBe(true);
  });

  it('does not mistake prose with code keywords for code, or speaker names for mentions', () => {
    expect(extractFeatures(ctx('dude can you return my drill this weekend?')).codeScore).toBeLessThan(0.45);
    expect(extractFeatures(ctx('try:\n    run()\nexcept Exception:\n    raise')).codeScore).toBeGreaterThanOrEqual(0.45);
    expect(extractFeatures(ctx(THREAD)).namePairs).toEqual([]);
    expect(extractFeatures(ctx('[10:31] Tomas Berg: ask Grace Hopper')).namePairs).toEqual(['Grace Hopper']);
    expect(extractFeatures(ctx('Hi Alex, thanks')).namePairs).toEqual([]);
    expect(extractFeatures(ctx('p50 42ms, p90 118ms, p99 410ms, error rate 0.4%')).numericDensity).toBeGreaterThan(0.3);
  });

  it('stays fast on large selections', () => {
    const big = ctx((THREAD + '\n' + TABLE + '\n' + ARTICLE + '\n').repeat(40));
    const t = performance.now();
    extractFeatures(big);
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe('decideByRules', () => {
  it('classifies content types', () => {
    expect(rules(ctx(CODE)).content_type).toBe('code');
    expect(rules(ctx(TABLE)).content_type).toBe('table_or_numbers');
    expect(rules(ctx(THREAD)).content_type).toBe('message_thread');
    expect(rules(ctx('Sam Lee\nsam@acme.io\n555-123-4567')).content_type).toBe('contact_info');
    expect(rules(ctx('lunch at noon works for me', { source_app: 'slack.exe' })).content_type).toBe('single_message');
    expect(rules(ctx('What does this flag actually do?')).content_type).toBe('question');
    expect(rules(ctx(ARTICLE)).content_type).toBe('article');
    const paragraph = 'Spaced repetition works because forgetting is a signal. Each time you retrieve something as it fades, the trace becomes more durable, and the interval before the next review can grow longer. Short reviews beat cramming.';
    expect(rules(ctx(paragraph)).content_type).toBe('article');
    expect(rules(ctx(`${paragraph} John Snow agreed.`)).mentions_people).toBeLessThan(0.5);
    expect(rules(ctx('a few plain words')).content_type).toBe('other');
  });

  it('treats editable text as the user’s own and caps commitments in tables and code', () => {
    expect(rules(ctx(THREAD)).authored_by_other).toBeGreaterThan(0.5);
    expect(rules(ctx(THREAD, { is_editable: true })).authored_by_other).toBeLessThanOrEqual(0.15);
    expect(rules(ctx(THREAD)).contains_commitment).toBe(0.75);
    expect(rules(ctx(`${TABLE}\nI'll send it by Friday`)).contains_commitment).toBeLessThanOrEqual(0.2);
  });

  it('picks collections from the user’s list only', () => {
    expect(rules(ctx(ARTICLE)).best_collection).toBe('Reading');
    expect(rules(ctx('Sam Lee\nsam@acme.io\n555-123-4567')).best_collection).toBe('People notes');
    expect(rules(ctx('what if we could ship weekly')).best_collection).toBe('Ideas');
    const f = extractFeatures(ctx(ARTICLE));
    expect(ruleCollection('article', f, ['Inbox'])).toBe('Inbox');
    expect(ruleCollection('article', f, [])).toBe('Notes');
  });
});

describe('slots', () => {
  const base: Decisions = {
    content_type: 'message_thread',
    authored_by_other: 0.9,
    mentions_people: 0.6,
    contains_commitment: 0.3,
    best_collection: 'Notes',
    provider: 'rules',
  };
  const f = extractFeatures(ctx('x'));

  it('scores contextual actions per the spec', () => {
    expect(scoreActions(base, f)).toEqual({ reply: 0.9, who: 0.6, promises: 0.3, visualize: 0 });
    expect(scoreActions({ ...base, content_type: 'article' }, f).reply).toBe(0);
    expect(scoreActions({ ...base, content_type: 'table_or_numbers' }, f).visualize).toBe(1);
    expect(scoreActions(base, { ...f, knownPeople: ['p1'] }).who).toBe(1);
  });

  it('offers Tasks on a message from someone you have open tasks with (decision 36)', () => {
    const quiet = { ...base, content_type: 'single_message' as const, contains_commitment: 0.05 };
    expect(scoreActions(quiet, f).promises).toBe(0.05);
    expect(scoreActions(quiet, { ...f, peopleWithTasks: 1 }).promises).toBe(0.55);
    // Not on an article that happens to name them.
    expect(scoreActions({ ...quiet, content_type: 'article' }, { ...f, peopleWithTasks: 1 }).promises).toBe(0.05);
    const people = [{ id: 'p1', name: 'Jordan Hale', aliases: [], open: 2 }, { id: 'p2', name: 'Casey Lin', aliases: [], open: 0 }];
    expect(extractFeatures(ctx('Jordan Hale and Casey Lin said hi'), people).peopleWithTasks).toBe(1);
  });

  it('offers Who on a contact card even when the model scores people low', () => {
    const card = 'Full Name: Jordan Hale\nRole: Backend\nEmail: jordan.hale@example.com\nPhone: +1 (555) 123-4567';
    const low = { ...base, content_type: 'contact_info' as const, mentions_people: 0.1 };
    expect(scoreActions(low, extractFeatures(ctx(card))).who).toBe(0.9);
    // The same card read as a message still has a name next to a phone and an address.
    expect(scoreActions({ ...low, content_type: 'single_message' }, extractFeatures(ctx(card))).who).toBe(0.7);
    // A no-reply address next to a name is not a person to look up.
    expect(scoreActions({ ...low, content_type: 'single_message' }, extractFeatures(ctx('Jordan Hale via noreply@example.com'))).who).toBe(0.1);
  });

  it('fills slots 3 and 4 above 0.5 and puts the rest above 0.2 under More', () => {
    const s = assignSlots(base, f, DEFAULT_SETTINGS.router);
    expect(s.slot3?.action).toBe('reply');
    expect(s.slot4?.action).toBe('who');
    expect(s.more.map((m) => m.action)).toEqual(['promises']);
    const none = assignSlots({ ...base, authored_by_other: 0.1, mentions_people: 0.1, contains_commitment: 0.1 }, f, DEFAULT_SETTINGS.router);
    expect([none.slot3, none.slot4, none.more]).toEqual([null, null, []]);
  });

  it('never shows a third slot, however many actions score high, and drops the ones under the More bar', () => {
    const scores = { reply: 0.95, who: 0.9, promises: 0.85, visualize: 0.7, search: 0.6, paste_list: 0.15, paste_summary: 0.55 };
    const order = ['reply', 'who', 'promises', 'visualize', 'search', 'paste_list', 'paste_summary'] as const;
    const s = rankSlots(scores, order, DEFAULT_SETTINGS.router);
    expect([s.slot3?.action, s.slot4?.action]).toEqual(['reply', 'who']);
    expect(s.more.map((m) => m.action)).toEqual(['promises', 'visualize', 'search', 'paste_summary']);
  });

  it('breaks ties in a stable order', () => {
    const s = assignSlots({ ...base, authored_by_other: 0.8, mentions_people: 0.8, contains_commitment: 0.8 }, f, DEFAULT_SETTINGS.router);
    expect([s.slot3?.action, s.slot4?.action, s.more[0]?.action]).toEqual(['reply', 'who', 'promises']);
  });
});

const modelDecision: Decisions = {
  content_type: 'single_message',
  authored_by_other: 0.9,
  mentions_people: 0.2,
  contains_commitment: 0.8,
  best_collection: 'Notes',
  provider: 'llm_structured',
};

function slowDecision(ms: number, seen: { aborted: boolean }): DecisionProvider {
  return {
    id: 'llm_structured',
    decide: (_input, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(modelDecision), ms);
        signal?.addEventListener('abort', () => {
          seen.aborted = true;
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      }),
  };
}

function router(decision: DecisionProvider | null, over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  return new Router({
    decision,
    settings: () => ({ ...DEFAULT_SETTINGS, ...over, router: { ...DEFAULT_SETTINGS.router, decisionTimeoutMs: 50 } }),
    collections: () => collections,
  });
}

describe('Router', () => {
  it('uses the model decision when it answers in time', async () => {
    const r = await router(slowDecision(5, { aborted: false })).route(ctx(THREAD));
    expect(r.fallback).toBeNull();
    expect(r.decisions.provider).toBe('llm_structured');
    expect(r.slots.slot3?.action).toBe('reply');
  });

  it('falls back to rules on timeout and aborts the slow call', async () => {
    const seen = { aborted: false };
    const r = await router(slowDecision(500, seen)).route(ctx(THREAD));
    expect(r.fallback).toBe('timeout');
    expect(r.decisions.provider).toBe('rules');
    expect(seen.aborted).toBe(true);
    expect(r.ms).toBeLessThan(300);
  });

  it('falls back on errors, missing models, and local-only mode', async () => {
    const failing: DecisionProvider = { id: 'llm_structured', decide: async () => Promise.reject(new Error('boom')) };
    expect((await router(failing).route(ctx(THREAD))).fallback).toBe('error');
    expect((await router(null).route(ctx(THREAD))).fallback).toBe('no_model');
    const called = { n: 0 };
    const counting: DecisionProvider = { id: 'llm_structured', decide: async () => (called.n++, modelDecision) };
    expect((await router(counting, { privacy: 'local' }).route(ctx(THREAD))).fallback).toBe('local_only');
    expect(called.n).toBe(0);
  });

  it('quick() is rules only', () => {
    const r = router(slowDecision(5, { aborted: false })).quick(ctx(TABLE));
    expect(r.decisions.provider).toBe('rules');
    expect(r.slots.slot3?.action).toBe('visualize');
  });
});

describe('LlmStructuredDecision', () => {
  function fakeLlm(out: Omit<Decisions, 'provider'> & { provider?: string }): LlmProvider & { calls: ChatRequest[] } {
    const calls: ChatRequest[] = [];
    return {
      calls,
      stream: () => {
        throw new Error('unused');
      },
      structured: async <T>(req: ChatRequest, schema: z.ZodType<T>) => {
        calls.push(req);
        return schema.parse({ provider: 'llm_structured', ...out });
      },
      hasModel: () => true,
    };
  }

  it('calls the decision role, and its schema allows only the known collections', async () => {
    const llm = fakeLlm({ ...modelDecision, best_collection: 'Reading' });
    const c = ctx(ARTICLE);
    const input = { context: c, features: extractFeatures(c), collections };
    const d = await new LlmStructuredDecision(llm).decide(input);
    expect(d.best_collection).toBe('Reading');
    expect(d.provider).toBe('llm_structured');
    expect(llm.calls[0]).toMatchObject({ role: 'decision', action: 'router', temperature: 0 });

    // An enum of the user's collections: anything else fails the schema, and the router falls back to rules.
    await expect(new LlmStructuredDecision(fakeLlm({ ...modelDecision, best_collection: 'Taxes' })).decide(input)).rejects.toThrow();
  });

  it('formats the prompt with clipped tier-1 context', () => {
    const c = ctx('SEL', { context_before: 'b'.repeat(900), context_after: 'after', source_app: 'slack.exe' });
    const p = formatDecisionPrompt({ context: c, features: extractFeatures(c), collections });
    expect(p).toContain('App: slack.exe');
    expect(p).toContain(`<before>\n${'b'.repeat(500)}\n</before>`);
    expect(p).toContain('<selection>\nSEL\n</selection>');
    expect(p).toContain('Collections: Notes, Reading, Ideas, People notes');
  });
});
