import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError, streamText, type LanguageModel, type LanguageModelUsage } from 'ai';
import { z } from 'zod';
import type { ModelRef, RoleName, Settings } from '../settings';
import { LOCAL_PROVIDER, lookupCapabilities, parseRef } from './catalog';
import { isLoopbackUrl } from './providers';
import { modelChain } from './roles';
import { LlmError, type ChatRequest, type LlmProvider, type SpokenToolResult, type StreamResult } from './types';

export interface AiSdkLlmDeps {
  settings: () => Pick<Settings, 'roles' | 'actionModels' | 'privacy' | 'local'>;
  /**
   * Decrypted key for a provider, or null when it can't be used. A provider that needs no key
   * (the local server, once set up) gives ''. Never logged.
   */
  apiKey: (provider: string) => string | null;
  /** Builds a model from a ref. Defaults to the provider registry; tests pass mocks. */
  createModel: (ref: ModelRef, apiKey: string) => LanguageModel;
  /** Called on each fallback, with no text: for metrics. */
  onFallback?: (info: LlmFallback) => void;
  /** Token counts after each call that reached a model (each try of a structured call counts), for metrics. */
  onUsage?: (usage: LlmUsage) => void;
  /**
   * Every try on a model, with its prompt and answer, for the call log (decision 61). Holds the
   * user's text: the caller keeps it only while the user has the log on, and never logs it.
   */
  onCall?: (call: LlmCall) => void;
  /** Monotonic clock for the rate-limit memory (default `performance.now`); tests pass their own. */
  now?: () => number;
  /**
   * Which SDK's options (reasoning effort, Groq's structured mode) a provider takes, by the way
   * it talks (decision 79): Ramp Router talks like OpenAI. Default: the provider id itself.
   */
  optionsKey?: (provider: string) => 'groq' | 'openai' | null;
}

const defaultOptionsKey = (provider: string): 'groq' | 'openai' | null => (provider === 'groq' || provider === 'openai' ? provider : null);

/** A call moved to the next model in its chain. Codes only. */
export interface LlmFallback {
  action: string;
  role: RoleName;
  from: ModelRef;
  to: ModelRef;
  status: number | undefined;
  /** rate_limit: this call got a 429; remembered: an earlier 429 still holds, so the model was skipped; server: a 5xx. */
  reason: 'rate_limit' | 'remembered' | 'server';
}

/** One try on one model (decision 61). `prompt` and `response` are the user's text. */
export interface LlmCall {
  action: string;
  role: RoleName;
  model: ModelRef;
  /** The model this call moved from, when it is a fallback. */
  fallbackFrom: ModelRef | null;
  status: 'ok' | 'error' | 'aborted' | 'invalid_output';
  /** HTTP status or error code when it failed. */
  error: string | null;
  ms: number;
  prompt: string;
  response: string | null;
  usage: LlmUsage | null;
}

/** One model call's token counts (decision 48). Codes and counts only. */
export interface LlmUsage {
  action: string;
  role: RoleName;
  provider: string;
  /** The model, and how long the call took: a model's measured speed comes from these (decision 79). */
  model: ModelRef;
  ms: number;
  input: number;
  output: number;
  /** Prompt tokens served from the provider's cache (they don't count toward Groq's limits). */
  cached: number;
  reasoning: number;
}

function usageOf(req: ChatRequest, ref: ModelRef, u: LanguageModelUsage | undefined, t0: number): LlmUsage | null {
  if (!u) return null;
  return {
    action: req.action ?? req.role,
    role: req.role,
    provider: parseRef(ref).provider,
    model: ref,
    ms: Math.round(performance.now() - t0),
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cached: u.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoning: u.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

function statusOf(e: unknown): number | undefined {
  if (RetryError.isInstance(e)) return statusOf(e.lastError);
  if (APICallError.isInstance(e)) return e.statusCode;
  const s = (e as { statusCode?: unknown })?.statusCode;
  return typeof s === 'number' ? s : undefined;
}

/** 429 and 5xx switch to the role's fallback model. */
export function isFallbackError(e: unknown): boolean {
  const s = statusOf(e);
  return s === 429 || (s !== undefined && s >= 500);
}

const RETRY_DEFAULT_MS = 10_000;
const RETRY_MAX_MS = 60 * 60_000;

/** Groq-style durations: "7.66s", "2m59.56s", "1h2m", "500ms". */
function durationMs(v: string): number | null {
  const parts = [...v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== v.trim()) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  return parts.reduce((t, p) => t + Number(p[1]) * unit[p[2] as keyof typeof unit], 0);
}

/**
 * How long a 429 says to wait, from the response's `retry-after` (seconds or a date), else
 * Groq's `x-ratelimit-reset-tokens`, else 10 s; kept between 1 s and an hour (decision 60).
 * `wallNow` is only for a date: it turns that into a wait.
 */
export function retryAfterMs(e: unknown, wallNow = Date.now()): number {
  const inner = RetryError.isInstance(e) ? e.lastError : e;
  const h = APICallError.isInstance(inner) ? (inner.responseHeaders ?? {}) : {};
  const get = (k: string) => Object.entries(h).find(([key]) => key.toLowerCase() === k)?.[1];
  let ms: number | null = null;
  const ra = get('retry-after')?.trim();
  if (ra) ms = /^\d+(\.\d+)?$/.test(ra) ? Number(ra) * 1000 : Number.isNaN(Date.parse(ra)) ? null : Date.parse(ra) - wallNow;
  if (ms === null) {
    const reset = get('x-ratelimit-reset-tokens');
    ms = reset ? durationMs(reset) : null;
  }
  return Math.min(RETRY_MAX_MS, Math.max(1000, ms ?? RETRY_DEFAULT_MS));
}

function toLlmError(e: unknown, ref?: ModelRef): LlmError {
  if (e instanceof LlmError) return e;
  if ((e as Error)?.name === 'AbortError') return new LlmError('aborted', 'Cancelled');
  const status = statusOf(e);
  const inner = RetryError.isInstance(e) ? e.lastError : e;
  // A call to a local server that got no HTTP answer: the server isn't running.
  if (ref && isLocal(ref) && APICallError.isInstance(inner) && status === undefined) return new LlmError('provider', LOCAL_UNREACHABLE_MESSAGE);
  return new LlmError('provider', (inner as Error)?.message ?? 'Model call failed', status);
}

/** Output tokens added for a reasoning model's thinking on structured calls (decision 60). */
export const REASONING_ROOM = 512;

export const LOCAL_ONLY_MESSAGE = 'Local only is on and no local model is set up, so nothing is sent.';
export const LOCAL_UNREACHABLE_MESSAGE = "Couldn't reach the local model. Check that Ollama or LM Studio is running.";

const isLocal = (ref: ModelRef) => parseRef(ref).provider === LOCAL_PROVIDER;

/**
 * The models a call may use, in order, before keys are checked. Under Local only (decision 34)
 * that is the local models in the role's chain, then the Local only model, and only while the
 * server is on this computer; never a cloud model.
 */
export function privacyChain(settings: Pick<Settings, 'roles' | 'actionModels' | 'privacy' | 'local'>, role: RoleName, action?: string): ModelRef[] {
  const chain = modelChain(role, settings, action);
  if (settings.privacy === 'all') return chain;
  if (!settings.local.baseUrl || !isLoopbackUrl(settings.local.baseUrl)) return [];
  return [...new Set([...chain.filter(isLocal), ...(settings.local.model ? [settings.local.model] : [])])];
}

/**
 * LlmProvider on the Vercel AI SDK: role resolution, 429/5xx fallback, one structured retry.
 * Every model call goes through here, so this is the one place that enforces Local only: while
 * it is on, a call goes only to a local model, and fails with `local_only` before anything is
 * sent when there is none.
 */
export class AiSdkLlm implements LlmProvider {
  /**
   * Models that answered 429, and until when (decision 60). A call skips them while another
   * model in its chain is free. Each new 429 replaces the time with the provider's latest
   * answer, a success on the model clears it, and it lapses at the time; in memory only.
   */
  private readonly limited = new Map<ModelRef, number>();

  constructor(private readonly deps: AiSdkLlmDeps) {}

  private now(): number {
    // Monotonic, so a change to the system clock can't stretch or cut a wait.
    return (this.deps.now ?? performance.now.bind(performance))();
  }

  private resolve(role: RoleName, action?: string): ModelRef[] {
    return privacyChain(this.deps.settings(), role, action).filter((ref) => this.deps.apiKey(parseRef(ref).provider) !== null);
  }

  private chain(role: RoleName, action?: string): { ref: ModelRef; model: LanguageModel }[] {
    const refs = this.resolve(role, action);
    if (refs.length === 0 && this.deps.settings().privacy === 'local') throw new LlmError('local_only', LOCAL_ONLY_MESSAGE);
    return refs.map((ref) => ({ ref, model: this.deps.createModel(ref, this.deps.apiKey(parseRef(ref).provider)!) }));
  }

  /** Until when a model is rate-limited (on `now`'s clock), or null. A lapsed entry is dropped. */
  limitedUntil(ref: ModelRef): number | null {
    const until = this.limited.get(ref);
    if (until === undefined) return null;
    if (until <= this.now()) {
      this.limited.delete(ref);
      return null;
    }
    return until;
  }

  /**
   * The chain without the models still rate-limited, reporting each skip as a fallback. When
   * every model is limited, the whole chain is tried: a fresh 429 refreshes the times.
   */
  private usable<C extends { ref: ModelRef }>(chain: C[], req: ChatRequest): C[] {
    const free = chain.filter((c) => this.limitedUntil(c.ref) === null);
    if (free.length === 0 || free.length === chain.length) return chain;
    const first = free[0]!;
    for (const c of chain.slice(0, chain.indexOf(first))) this.fellBack(req, c.ref, first.ref, 429, 'remembered');
    return free;
  }

  private fellBack(req: ChatRequest, from: ModelRef, to: ModelRef, status: number | undefined, reason: LlmFallback['reason']): void {
    this.deps.onFallback?.({ action: req.action ?? req.role, role: req.role, from, to, status, reason });
    req.onFallback?.(to);
  }

  /** After a failed try: remembers a 429, and says whether the call moves on to `next`. */
  private failed(req: ChatRequest, ref: ModelRef, e: unknown, next: ModelRef | undefined): boolean {
    const status = statusOf(e);
    if (status === 429) this.limited.set(ref, this.now() + retryAfterMs(e));
    if (!next || !isFallbackError(e) || req.signal?.aborted) return false;
    this.fellBack(req, ref, next, status, status === 429 ? 'rate_limit' : 'server');
    return true;
  }

  private logCall(req: ChatRequest, ref: ModelRef, from: ModelRef | null, t0: number, out: { response: string | null; error?: unknown; usage: LlmUsage | null; prompt?: string }): void {
    if (!this.deps.onCall) return;
    const e = out.error;
    const status: LlmCall['status'] =
      e === undefined ? 'ok' : req.signal?.aborted || (e as Error)?.name === 'AbortError' || (e instanceof LlmError && e.code === 'aborted') ? 'aborted' : e instanceof LlmError && e.code === 'invalid_output' ? 'invalid_output' : 'error';
    const code = e === undefined ? null : (statusOf(e)?.toString() ?? (e instanceof LlmError ? e.code : ((e as Error)?.name ?? 'error')));
    this.deps.onCall({
      action: req.action ?? req.role,
      role: req.role,
      model: ref,
      fallbackFrom: from,
      status,
      error: code,
      ms: Math.round(performance.now() - t0),
      prompt: out.prompt ?? req.prompt,
      response: out.response,
      usage: out.usage,
    });
  }

  /** True if the role resolves to a usable model under the current privacy choice. */
  hasModel(role: RoleName): boolean {
    return this.resolve(role).length > 0;
  }

  stream(req: ChatRequest): StreamResult {
    let chain: { ref: ModelRef; model: LanguageModel }[] = [];
    let refused: LlmError | null = null;
    try {
      chain = this.usable(this.chain(req.role, req.action), req);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      refused = e;
    }
    let resolveModel!: (r: ModelRef) => void;
    let rejectModel!: (e: unknown) => void;
    const model = new Promise<ModelRef>((res, rej) => {
      resolveModel = res;
      rejectModel = rej;
    });
    model.catch(() => {});
    const deps = this.deps;
    const self = this;

    async function* run(): AsyncGenerator<string> {
      if (refused) {
        rejectModel(refused);
        throw refused;
      }
      if (chain.length === 0) {
        const e = new LlmError('no_model', `No ${req.role} model is set up. Add a key in Settings.`);
        rejectModel(e);
        throw e;
      }
      for (let i = 0; i < chain.length; i++) {
        const { ref, model: m } = chain[i]!;
        const from = i > 0 ? chain[i - 1]!.ref : null;
        const t0 = performance.now();
        let text = '';
        let started = false;
        const start = () => {
          if (started) return;
          started = true;
          resolveModel(ref);
        };
        const { provider, modelId } = parseRef(ref);
        const tools = req.tools && lookupCapabilities(provider, modelId)?.tools !== false ? req.tools : undefined;
        // A reasoning model streams at the effort asked for (Reply asks for low), never above its own.
        const caps = lookupCapabilities(provider, modelId);
        const effort = req.reasoning && caps?.reasoning && caps.reasoning !== 'none' ? req.reasoning : undefined;
        const sdk = (deps.optionsKey ?? defaultOptionsKey)(provider);
        const providerOptions: Record<string, Record<string, string>> | undefined = effort && sdk ? { [sdk]: { reasoningEffort: effort } } : undefined;
        try {
          const result = streamText({
            model: m,
            instructions: req.instructions,
            prompt: req.prompt,
            abortSignal: req.signal,
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature,
            maxRetries: 0,
            ...(tools && { tools }),
            ...(tools &&
              req.continueAfterTools && {
                stopWhen: ({ steps }: { steps: { text: string; toolCalls: { input: unknown }[] }[] }) => {
                  const last = steps.at(-1);
                  return steps.length >= 2 || !last || !req.continueAfterTools!({ text: last.text, toolInputs: last.toolCalls.map((c) => c.input) });
                },
              }),
            ...(providerOptions && { providerOptions }),
          });
          for await (const part of result.stream) {
            if (part.type === 'text-delta') {
              start();
              text += part.text;
              yield part.text;
            } else if (part.type === 'tool-result') {
              start();
              const say = (part.output as Partial<SpokenToolResult> | undefined)?.say;
              if (typeof say === 'string' && say) yield say;
            } else if (part.type === 'tool-error') {
              start();
              yield 'That did not work, so nothing was saved.';
            } else if (part.type === 'error') {
              throw part.error;
            } else if (part.type === 'abort') {
              throw new LlmError('aborted', 'Cancelled');
            }
          }
          if (!started) resolveModel(ref);
          const used = usageOf(req, ref, await Promise.resolve(result.usage).catch(() => undefined), t0);
          if (used) deps.onUsage?.(used);
          self.limited.delete(ref);
          self.logCall(req, ref, from, t0, { response: text, usage: used });
          return;
        } catch (e) {
          self.logCall(req, ref, from, t0, { response: text || null, error: e, usage: null });
          if (!started && self.failed(req, ref, e, chain[i + 1]?.ref)) continue;
          if (statusOf(e) === 429 && started) self.limited.set(ref, self.now() + retryAfterMs(e));
          const err = req.signal?.aborted ? new LlmError('aborted', 'Cancelled') : toLlmError(e, ref);
          rejectModel(err);
          throw err;
        }
      }
    }

    return { textStream: run(), model };
  }

  async structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T> {
    const all = this.chain(req.role, req.action);
    if (all.length === 0) throw new LlmError('no_model', `No ${req.role} model is set up. Add a key in Settings.`);
    const chain = this.usable(all, req);
    for (let i = 0; i < chain.length; i++) {
      const { ref, model } = chain[i]!;
      try {
        const out = await this.structuredOnModel(ref, model, req, schema, i > 0 ? chain[i - 1]!.ref : null);
        this.limited.delete(ref);
        return out;
      } catch (e) {
        if (this.failed(req, ref, e, chain[i + 1]?.ref)) continue;
        throw req.signal?.aborted ? new LlmError('aborted', 'Cancelled') : toLlmError(e, ref);
      }
    }
    throw new LlmError('provider', 'Model call failed');
  }

  /** One call, plus one retry that tells the model what was wrong with its answer. */
  private async structuredOnModel<T>(ref: ModelRef, model: LanguageModel, req: ChatRequest, schema: z.ZodType<T>, from: ModelRef | null): Promise<T> {
    const { provider, modelId } = parseRef(ref);
    const caps = lookupCapabilities(provider, modelId);
    const jsonMode = caps?.structured !== 'json_schema';
    // Without native schema support the model needs to see the schema itself.
    const instructions = jsonMode
      ? `${req.instructions}\n\nRespond with only a JSON object matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`
      : req.instructions;
    const reasoningEffort = caps?.reasoning;
    const sdk = (this.deps.optionsKey ?? defaultOptionsKey)(provider);
    const providerOptions: Record<string, Record<string, string | boolean>> | undefined =
      sdk === 'groq'
        ? { groq: { structuredOutputs: !jsonMode, ...(reasoningEffort && { reasoningEffort }) } }
        : sdk === 'openai' && reasoningEffort
          ? { openai: { reasoningEffort } }
          : undefined;

    // Reasoning tokens count against the output cap, so a reasoning model gets room for them on top.
    const maxOutputTokens = req.maxOutputTokens && reasoningEffort && reasoningEffort !== 'none' ? req.maxOutputTokens + REASONING_ROOM : req.maxOutputTokens;
    let prompt = req.prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = performance.now();
      try {
        const { output, usage } = await generateText({
          model,
          instructions,
          prompt,
          output: Output.object({ schema }),
          abortSignal: req.signal,
          maxOutputTokens,
          temperature: req.temperature,
          maxRetries: 0,
          providerOptions,
        });
        const used = usageOf(req, ref, usage, t0);
        if (used) this.deps.onUsage?.(used);
        this.logCall(req, ref, from, t0, { prompt, response: JSON.stringify(output), usage: used });
        return output as T;
      } catch (e) {
        const used = NoObjectGeneratedError.isInstance(e) ? usageOf(req, ref, e.usage, t0) : null;
        if (used) this.deps.onUsage?.(used);
        this.logCall(req, ref, from, t0, {
          prompt,
          response: NoObjectGeneratedError.isInstance(e) ? (e.text ?? null) : null,
          error: NoObjectGeneratedError.isInstance(e) ? new LlmError('invalid_output', 'invalid') : e,
          usage: used,
        });
        if (!NoObjectGeneratedError.isInstance(e) || attempt === 1) {
          if (NoObjectGeneratedError.isInstance(e)) throw new LlmError('invalid_output', 'The model returned invalid structured output');
          throw e;
        }
        const reason = (e.cause as Error | undefined)?.message ?? e.message;
        prompt = `${req.prompt}\n\nYour previous answer was not valid: ${reason.slice(0, 500)}\nReturn only JSON that matches the schema.`;
      }
    }
    throw new LlmError('invalid_output', 'The model returned invalid structured output');
  }
}
