import type { ToolSet } from 'ai';
import type { z } from 'zod';
import type { ModelRef, RoleName } from '../settings';

export interface ChatRequest {
  /** Which role's model to use, e.g. "fast" for extraction and "chat" for Ask. */
  role: RoleName;
  /** Action name for per-action model overrides ("ask", "save_entities", ...). */
  action?: string;
  instructions: string;
  prompt: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Tools for a streamed call (Ask's "remember"). One step only: the tool runs, and a result
   * with a `say` string is streamed as text, so the model is never called a second time.
   * Left out for models whose capabilities say they have no tools.
   */
  tools?: ToolSet;
}

/** What a tool returns to be reported in the stream. */
export interface SpokenToolResult {
  say: string;
}

export interface StreamResult {
  /** Text chunks as they arrive. */
  textStream: AsyncIterable<string>;
  /** The model that actually served the request (after any fallback). */
  model: Promise<ModelRef>;
}

export interface LlmProvider {
  stream(req: ChatRequest): StreamResult;
  structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T>;
  /** True if the role resolves to a usable model. */
  hasModel(role: RoleName): boolean;
}

export class LlmError extends Error {
  constructor(
    readonly code: 'no_model' | 'local_only' | 'invalid_output' | 'provider' | 'aborted' | 'timeout',
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
