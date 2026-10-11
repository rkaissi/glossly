// Helpers for the comparison evals: a real model through AiSdkLlm, with no fallback model (so a
// failure isn't hidden by a second model), counting the provider calls and output tokens of each
// case, and waiting out the free tier's per-minute limits.
import type { LanguageModel } from 'ai';
import { AiSdkLlm, DEFAULT_SETTINGS, parseRef, PROVIDERS, type ModelRef } from '@glossly/core';

export interface Counted {
  llm: AiSdkLlm;
  /** Provider calls and output tokens since the last reset (one case). */
  calls: () => { attempts: number; outputTokens: number };
  reset: () => void;
}

export const groqKey = () => process.env.GROQ_API_KEY ?? null;

export function countedLlm(modelRef: ModelRef): Counted {
  let attempts = 0;
  let outputTokens = 0;
  const wrap = (model: LanguageModel): LanguageModel =>
    new Proxy(model as object, {
      get(target, prop, receiver) {
        if (prop === 'doGenerate') {
          return async (opts: unknown) => {
            attempts++;
            const r = await (target as { doGenerate: (o: unknown) => Promise<{ usage?: { outputTokens?: { total?: number } } }> }).doGenerate(opts);
            outputTokens += r.usage?.outputTokens?.total ?? 0;
            return r;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as LanguageModel;
  const role = { model: modelRef, fallback: null, manual: true };
  const llm = new AiSdkLlm({
    settings: () => ({ ...DEFAULT_SETTINGS, roles: { ...DEFAULT_SETTINGS.roles, fast: role, decision: { ...role } } }),
    apiKey: (p) => (p === 'groq' ? groqKey() : (process.env[`${p.toUpperCase()}_API_KEY`] ?? null)),
    createModel: (ref, key) => wrap(PROVIDERS[parseRef(ref).provider]!.createModel(key, parseRef(ref).modelId)),
  });
  return {
    llm,
    calls: () => ({ attempts, outputTokens }),
    reset: () => {
      attempts = 0;
      outputTokens = 0;
    },
  };
}

/** Calls are spaced at least this far apart, so a run stays near the free tier's tokens per minute. */
const GAP_MS = Number(process.env.GLOSSLY_COMPARE_GAP_MS ?? 2500);
let lastCall = 0;

/** Free-tier keys hit per-minute limits; wait as the provider asks (or 20 s) and try again. `before` runs before each try. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, before?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    before?.();
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      if (err.statusCode !== 429 || attempt >= 20) throw e;
      const s = Number(/try again in ([\d.]+)s/i.exec(err.message)?.[1] ?? 20);
      await new Promise((r) => setTimeout(r, Math.min(s + 1, 60) * 1000));
    }
  }
}

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
