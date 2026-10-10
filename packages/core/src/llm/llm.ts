import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError, streamText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { ModelRef, RoleName, Settings } from '../settings';
import { lookupCapabilities, parseRef } from './catalog';
import { modelChain } from './roles';
import { LlmError, type ChatRequest, type LlmProvider, type StreamResult } from './types';

export interface AiSdkLlmDeps {
  settings: () => Pick<Settings, 'roles' | 'actionModels' | 'localOnly'>;
  /** Decrypted key for a provider, or null. Never logged. */
  apiKey: (provider: string) => string | null;
  /** Builds a model from a ref. Defaults to the provider registry; tests pass mocks. */
  createModel: (ref: ModelRef, apiKey: string) => LanguageModel;
  /** Called on each fallback, with no text: for metrics. */
  onFallback?: (info: { from: ModelRef; to: ModelRef; status: number | undefined }) => void;
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

function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if ((e as Error)?.name === 'AbortError') return new LlmError('aborted', 'Cancelled');
  const status = statusOf(e);
  const inner = RetryError.isInstance(e) ? e.lastError : e;
  return new LlmError('provider', (inner as Error)?.message ?? 'Model call failed', status);
}

export const LOCAL_ONLY_MESSAGE = 'Local only is on, so nothing is sent to a model provider.';

/**
 * LlmProvider on the Vercel AI SDK: role resolution, 429/5xx fallback, one structured retry.
 * Every model call goes through here, so this is the one place that enforces Local only: while
 * it is on, every call fails with `local_only` before anything is sent (every provider is a
 * cloud provider for now).
 */
export class AiSdkLlm implements LlmProvider {
  constructor(private readonly deps: AiSdkLlmDeps) {}

  private chain(role: RoleName, action?: string): { ref: ModelRef; model: LanguageModel }[] {
    if (this.deps.settings().localOnly) throw new LlmError('local_only', LOCAL_ONLY_MESSAGE);
    const out: { ref: ModelRef; model: LanguageModel }[] = [];
    for (const ref of modelChain(role, this.deps.settings(), action)) {
      const key = this.deps.apiKey(parseRef(ref).provider);
      if (key) out.push({ ref, model: this.deps.createModel(ref, key) });
    }
    return out;
  }

  hasModel(role: RoleName): boolean {
    return modelChain(role, this.deps.settings()).some((ref) => this.deps.apiKey(parseRef(ref).provider));
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
        try {
          const result = streamText({
            model: m,
            instructions: req.instructions,
            prompt: req.prompt,
            abortSignal: req.signal,
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature,
            maxRetries: 0,
          });
          for await (const part of result.stream) {
            if (part.type === 'text-delta') {
              if (!started) {
                started = true;
                resolveModel(ref);
              }
              yield part.text;
            } else if (part.type === 'error') {
              throw part.error;
            } else if (part.type === 'abort') {
              throw new LlmError('aborted', 'Cancelled');
            }
          }
          if (!started) resolveModel(ref);
          return;
        } catch (e) {
          const next = chain[i + 1];
          if (!started && next && isFallbackError(e) && !req.signal?.aborted) {
            deps.onFallback?.({ from: ref, to: next.ref, status: statusOf(e) });
            continue;
          }
          const err = req.signal?.aborted ? new LlmError('aborted', 'Cancelled') : toLlmError(e);
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
        throw req.signal?.aborted ? new LlmError('aborted', 'Cancelled') : toLlmError(e);
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
        const { output } = await generateText({
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
        return output as T;
      } catch (e) {
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
