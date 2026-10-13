// Helpers for the evals: a real model through AiSdkLlm, with no fallback model (so a failure isn't
// hidden by a second model), counting the provider calls and tokens of each case, pacing calls
// under the free tier's tokens per minute, stopping on a daily limit, and a case limit so a run
// can start small (Step 21).
import type { LanguageModel } from 'ai';
import { AiSdkLlm, DEFAULT_SETTINGS, parseRef, PROVIDERS, type ModelRef } from '@glossly/core';

export interface Usage {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Counted {
  llm: AiSdkLlm;
  /** Provider calls and tokens since the last reset (one case). */
  calls: () => Usage;
  /** Provider calls and tokens over the whole run. */
  total: () => Usage;
  /** The rate-limit headers of the last answer (Groq: daily requests, tokens per minute). */
  limits: () => Limits | null;
  /** The text of the last answer (the structured JSON), to see what the model said on a miss. */
  answer: () => string | null;
  reset: () => void;
}

export const groqKey = () => process.env.GROQ_API_KEY ?? null;

/** The model a run uses: `GLOSSLY_EVAL_MODEL`, else the role's model on today's Groq catalog (decision 60). */
export const evalModel = (fallback: ModelRef): ModelRef => (process.env.GLOSSLY_EVAL_MODEL as ModelRef | undefined) ?? fallback;

type Gen = {
  doGenerate: (o: unknown) => Promise<{ usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } }; response?: { headers?: Record<string, string> }; content?: { type: string; text?: string }[] }>;
};

/** Groq's x-ratelimit headers: requests are per day (refilling one at a time), tokens per minute. */
export interface Limits {
  requestsLeft: number;
  requestsPerDay: number;
  tokensLeftThisMinute: number;
}

function readLimits(h: Record<string, string> | undefined): Limits | null {
  const n = (k: string) => Number(h?.[k] ?? NaN);
  const l = { requestsLeft: n('x-ratelimit-remaining-requests'), requestsPerDay: n('x-ratelimit-limit-requests'), tokensLeftThisMinute: n('x-ratelimit-remaining-tokens') };
  return Number.isFinite(l.requestsLeft) ? l : null;
}

/** An AiSdkLlm with `modelRef` in every role (Fast, Decision, Chat), no fallback, and call counting. */
export function countedLlm(modelRef: ModelRef): Counted {
  const now: Usage = { attempts: 0, inputTokens: 0, outputTokens: 0 };
  const all: Usage = { attempts: 0, inputTokens: 0, outputTokens: 0 };
  let last: Limits | null = null;
  let answer: string | null = null;
  const add = (u: Usage, i: number, o: number) => {
    u.attempts++;
    u.inputTokens += i;
    u.outputTokens += o;
  };
  const wrap = (model: LanguageModel): LanguageModel =>
    new Proxy(model as object, {
      get(target, prop, receiver) {
        if (prop === 'doGenerate') {
          return async (opts: unknown) => {
            const r = await (target as Gen).doGenerate(opts);
            const i = r.usage?.inputTokens?.total ?? 0;
            const o = r.usage?.outputTokens?.total ?? 0;
            last = readLimits(r.response?.headers) ?? last;
            answer = (r.content ?? []).flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join('') || answer;
            add(now, i, o);
            add(all, i, o);
            spent(i + o);
            return r;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as LanguageModel;
  const role = { model: modelRef, fallback: null, manual: true };
  const llm = new AiSdkLlm({
    settings: () => ({ ...DEFAULT_SETTINGS, roles: { fast: role, decision: { ...role }, chat: { ...role } } }),
    apiKey: (p) => (p === 'groq' ? groqKey() : (process.env[`${p.toUpperCase()}_API_KEY`] ?? null)),
    createModel: (ref, key) => wrap(PROVIDERS[parseRef(ref).provider]!.createModel(key, parseRef(ref).modelId)),
  });
  return {
    llm,
    calls: () => ({ ...now }),
    total: () => ({ ...all }),
    limits: () => last,
    answer: () => answer,
    reset: () => {
      now.attempts = 0;
      now.inputTokens = 0;
      now.outputTokens = 0;
    },
  };
}

// --- Pacing -----------------------------------------------------------------------------------

/** Tokens a run may spend in any 60 s, under the free tier's 8,000 per model, leaving room for the app. */
const TPM = Number(process.env.GLOSSLY_EVAL_TPM ?? 6000);
/** Calls are at least this far apart (30 requests a minute is the limit). */
const GAP_MS = Number(process.env.GLOSSLY_COMPARE_GAP_MS ?? 2500);
const window: { at: number; tokens: number }[] = [];
let lastCall = 0;
let lastTokens = 1500;

function spent(tokens: number) {
  window.push({ at: Date.now(), tokens });
  lastTokens = tokens || lastTokens;
}

/** Wait until the last minute's tokens plus a call like the last one fit under TPM, and GAP_MS has passed. */
async function pace() {
  for (;;) {
    const now = Date.now();
    while (window.length && now - window[0]!.at > 60_000) window.shift();
    const used = window.reduce((n, w) => n + w.tokens, 0);
    const gap = lastCall + GAP_MS - now;
    const full = used + lastTokens > TPM && window.length ? window[0]!.at + 60_000 - now + 50 : 0;
    const wait = Math.max(gap, full);
    if (wait <= 0) return;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Thrown when the provider asks for a long wait (the daily limit) or keeps refusing: the run stops. */
export class RateLimitStop extends Error {
  override name = 'RateLimitStop';
}

/** A wait longer than this means a daily limit, not a per-minute one. */
const MAX_WAIT_S = 60;
/** This many 429s in a row on one call stops the run (Rayan: stop on repeated 429s). */
const MAX_429 = 3;

/**
 * Paces the call, then retries a 429 after the wait the provider asks for, up to MAX_429 times.
 * A requested wait over a minute (the daily limit) or the last 429 throws `RateLimitStop`.
 * `before` runs before each try.
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, before?: () => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await pace();
    lastCall = Date.now();
    before?.();
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      if (err.statusCode !== 429 && !/rate.?limit|429/i.test(err.message ?? '')) throw e;
      const s = retrySeconds(err.message ?? '');
      if (s > MAX_WAIT_S) throw new RateLimitStop(`daily limit: the provider asks for ${Math.round(s)} s`);
      if (attempt >= MAX_429) throw new RateLimitStop(`${MAX_429} rate limits in a row`);
      await new Promise((r) => setTimeout(r, (s + 1) * 1000));
    }
  }
}

/** Groq's "try again in 1m2.5s" / "in 7.66s" / "in 450ms"; 20 s when it says nothing. */
export function retrySeconds(message: string): number {
  const m = /try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(message);
  if (!m || !m.slice(1).some(Boolean)) return 20;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 1000;
}

// --- Budget check -----------------------------------------------------------------------------

/** How often a run checks what's left of the day (Rayan: every 5 or 10 cases). */
export const CHECK_EVERY = Number(process.env.GLOSSLY_EVAL_CHECK_EVERY ?? 5);
/** Daily requests to keep for the app and the rest of the evals on this model. */
const RESERVE = Number(process.env.GLOSSLY_EVAL_RESERVE ?? 50);

/**
 * After every CHECK_EVERY cases: prints the day's requests left and this run's tokens, and returns
 * a reason to stop when the requests left won't cover the remaining cases (about `perCase` calls
 * each) plus the reserve. Cases run in turn across groups, so stopping early keeps a balanced set.
 * Groq doesn't report the daily token cap; reaching it stops the run through `RateLimitStop`.
 */
/** Every budget check this run, for the results file (Vitest may not print console output). */
export const budgetLog: { after: number; requests_left: number | null; requests_per_day: number | null; run_calls: number; run_tokens: number }[] = [];

export function budgetCheck(counted: Counted, done: number, left: number, perCase = 1): string | null {
  if (done === 0 || done % CHECK_EVERY !== 0) return null;
  const l = counted.limits();
  const t = counted.total();
  budgetLog.push({ after: done, requests_left: l?.requestsLeft ?? null, requests_per_day: l?.requestsPerDay ?? null, run_calls: t.attempts, run_tokens: t.inputTokens + t.outputTokens });
  console.log(`budget after ${done} cases: ${l ? `${l.requestsLeft}/${l.requestsPerDay} requests left today, ${l.tokensLeftThisMinute} tokens left this minute` : 'no limit headers'}; this run ${t.attempts} calls, ${t.inputTokens + t.outputTokens} tokens`);
  if (l && l.requestsLeft < left * perCase + RESERVE) return `budget: ${l.requestsLeft} requests left, ${left} cases to go`;
  return null;
}

// --- Case limit -------------------------------------------------------------------------------

/**
 * At most `GLOSSLY_EVAL_LIMIT` cases, taken in turn from each group (`group` defaults to the id's prefix,
 * "msg-04" → "msg"), so a small run still covers every kind. All cases when it's unset.
 */
export function limitCases<T extends { id: string }>(all: T[], group: (c: T) => string = (c) => c.id.replace(/-?\d+$/, '')): T[] {
  // GLOSSLY_EVAL_IDS (comma-separated) picks exact cases first, for a small comparison.
  const ids = process.env.GLOSSLY_EVAL_IDS?.split(',').map((s) => s.trim()).filter(Boolean);
  const cases = ids?.length ? all.filter((c) => ids.includes(c.id)) : all;
  const n = Math.min(Number(process.env.GLOSSLY_EVAL_LIMIT ?? 0) || cases.length, cases.length);
  const groups = new Map<string, T[]>();
  for (const c of cases) groups.set(group(c), [...(groups.get(group(c)) ?? []), c]);
  const out: T[] = [];
  for (let i = 0; out.length < n; i++) {
    for (const g of groups.values()) if (g[i] && out.length < n) out.push(g[i]!);
  }
  // In turn across groups, so a run cut short by the budget still covers every kind.
  return out;
}

/** A results file name: `<base>.json`, or `<base>-ids.json` for a run of picked cases (GLOSSLY_EVAL_IDS), so it never replaces a full run's file. */
export const resultsFile = (base: string) => `${base}${process.env.GLOSSLY_EVAL_IDS ? '-ids' : ''}.json`;

// --- Small helpers ----------------------------------------------------------------------------

/** A short error label: the provider's code when it gives one (json_validate_failed), else the error's name. */
export function errorLabel(e: unknown): string {
  const err = e as Error & { code?: string; statusCode?: number };
  const m = /"code":"([a-z_]+)"|code[=: ]+([a-z_]+)/i.exec(err.message ?? '');
  const code = m?.[1] ?? m?.[2];
  return [err.code ?? err.name, err.statusCode, code].filter(Boolean).join(':');
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};

export const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

/** Two names for the same person: equal ignoring case, or one is the other's first word ("Jordan" / "Jordan Hale"). */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.split(/\s+/)[0] === y || y.split(/\s+/)[0] === x;
}
