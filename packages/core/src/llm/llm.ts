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
  onFallback?: (info: { from: ModelRef; to: ModelRef; status: number | undefined }) => void;
  /** Token counts after each call that reached a model (each try of a structured call counts), for metrics. */
  onUsage?: (usage: LlmUsage) => void;
}

/** One model call's token counts (Step 20.4). Codes and counts only. */
export interface LlmUsage {
  action: string;
  role: RoleName;
  provider: string;
  input: number;
  output: number;
  /** Prompt tokens served from the provider's cache (they don't count toward Groq's limits). */
  cached: number;
  reasoning: number;
}

function usageOf(req: ChatRequest, ref: ModelRef, u: LanguageModelUsage | undefined): LlmUsage | null {
  if (!u) return null;
  return {
    action: req.action ?? req.role,
    role: req.role,
    provider: parseRef(ref).provider,
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

function toLlmError(e: unknown, ref?: ModelRef): LlmError {
  if (e instanceof LlmError) return e;
  if ((e as Error)?.name === 'AbortError') return new LlmError('aborted', 'Cancelled');
  const status = statusOf(e);
  const inner = RetryError.isInstance(e) ? e.lastError : e;
  // A call to a local server that got no HTTP answer: the server isn't running.
  if (ref && isLocal(ref) && APICallError.isInstance(inner) && status === undefined) return new LlmError('provider', LOCAL_UNREACHABLE_MESSAGE);
  return new LlmError('provider', (inner as Error)?.message ?? 'Model call failed', status);
}

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
  constructor(private readonly deps: AiSdkLlmDeps) {}

  private resolve(role: RoleName, action?: string): ModelRef[] {
    return privacyChain(this.deps.settings(), role, action).filter((ref) => this.deps.apiKey(parseRef(ref).provider) !== null);
  }

  private chain(role: RoleName, action?: string): { ref: ModelRef; model: LanguageModel }[] {
    const refs = this.resolve(role, action);
    if (refs.length === 0 && this.deps.settings().privacy === 'local') throw new LlmError('local_only', LOCAL_ONLY_MESSAGE);
    return refs.map((ref) => ({ ref, model: this.deps.createModel(ref, this.deps.apiKey(parseRef(ref).provider)!) }));
  }

  /** True if the role resolves to a usable model under the current privacy choice. */
  hasModel(role: RoleName): boolean {
    return this.resolve(role).length > 0;
  }

  stream(req: ChatRequest): StreamResult {
    let chain: { ref: ModelRef; model: LanguageModel }[] = [];
    let refused: LlmError | null = null;
    try {
      chain = this.chain(req.role, req.action);
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
        const providerOptions: Record<string, Record<string, string>> | undefined = effort ? (provider === 'groq' ? { groq: { reasoningEffort: effort } } : provider === 'openai' ? { openai: { reasoningEffort: effort } } : undefined) : undefined;
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
            ...(providerOptions && { providerOptions }),
          });
          for await (const part of result.stream) {
            if (part.type === 'text-delta') {
              start();
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
          const used = usageOf(req, ref, await Promise.resolve(result.usage).catch(() => undefined));
          if (used) deps.onUsage?.(used);
          return;
        } catch (e) {
          const next = chain[i + 1];
          if (!started && next && isFallbackError(e) && !req.signal?.aborted) {
            deps.onFallback?.({ from: ref, to: next.ref, status: statusOf(e) });
            continue;
          }
          const err = req.signal?.aborted ? new LlmError('aborted', 'Cancelled') : toLlmError(e, ref);
          rejectModel(err);
          throw err;
        }
      }
    }

    return { textStream: run(), model };
  }

  async structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T> {
    const chain = this.chain(req.role, req.action);
    if (chain.length === 0) throw new LlmError('no_model', `No ${req.role} model is set up. Add a key in Settings.`);
    for (let i = 0; i < chain.length; i++) {
      const { ref, model } = chain[i]!;
      try {
        return await this.structuredOnModel(ref, model, req, schema);
      } catch (e) {
        const next = chain[i + 1];
        if (next && isFallbackError(e) && !req.signal?.aborted) {
          this.deps.onFallback?.({ from: ref, to: next.ref, status: statusOf(e) });
          continue;
        }
        throw req.signal?.aborted ? new LlmError('aborted', 'Cancelled') : toLlmError(e, ref);
      }
    }
    throw new LlmError('provider', 'Model call failed');
  }

  /** One call, plus one retry that tells the model what was wrong with its answer. */
  private async structuredOnModel<T>(ref: ModelRef, model: LanguageModel, req: ChatRequest, schema: z.ZodType<T>): Promise<T> {
    const { provider, modelId } = parseRef(ref);
    const caps = lookupCapabilities(provider, modelId);
    const jsonMode = caps?.structured !== 'json_schema';
    // Without native schema support the model needs to see the schema itself.
    const instructions = jsonMode
      ? `${req.instructions}\n\nRespond with only a JSON object matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`
      : req.instructions;
    const reasoningEffort = caps?.reasoning;
    const providerOptions: Record<string, Record<string, string | boolean>> | undefined =
      provider === 'groq'
        ? { groq: { structuredOutputs: !jsonMode, ...(reasoningEffort && { reasoningEffort }) } }
        : provider === 'openai' && reasoningEffort
          ? { openai: { reasoningEffort } }
          : undefined;

    let prompt = req.prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { output, usage } = await generateText({
          model,
          instructions,
          prompt,
          output: Output.object({ schema }),
          abortSignal: req.signal,
          maxOutputTokens: req.maxOutputTokens,
          temperature: req.temperature,
          maxRetries: 0,
          providerOptions,
        });
        const used = usageOf(req, ref, usage);
        if (used) this.deps.onUsage?.(used);
        return output as T;
      } catch (e) {
        if (NoObjectGeneratedError.isInstance(e)) {
          const used = usageOf(req, ref, e.usage);
          if (used) this.deps.onUsage?.(used);
        }
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
