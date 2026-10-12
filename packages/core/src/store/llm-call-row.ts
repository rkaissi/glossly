import type { LlmCall } from '../llm/llm';

/** One row of the model call log (decision 61). `prompt` and `response` hold the user's text. */
export interface LlmCallRow {
  at: string;
  action: string;
  role: string;
  model: string;
  fallback_from: string | null;
  status: string;
  error: string | null;
  ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  prompt: string;
  response: string | null;
}

/** The call log keeps 30 days (Rayan, Oct 12). */
export const CALL_LOG_DAYS = 30;

export function toLlmCallRow(c: LlmCall, at: string): LlmCallRow {
  return {
    at,
    action: c.action,
    role: c.role,
    model: c.model,
    fallback_from: c.fallbackFrom,
    status: c.status,
    error: c.error,
    ms: c.ms,
    input_tokens: c.usage?.input ?? null,
    output_tokens: c.usage?.output ?? null,
    cached_tokens: c.usage?.cached ?? null,
    reasoning_tokens: c.usage?.reasoning ?? null,
    prompt: c.prompt,
    response: c.response,
  };
}
