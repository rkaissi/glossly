import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { isChatModel, LOCAL_PROVIDER, toCatalogModel, type CatalogModel } from './catalog';

export type FetchFn = typeof fetch;

export interface ProviderInfo {
  id: string;
  label: string;
  keyUrl: string;
  /** Shown as "Free" in first-run setup. */
  free: boolean;
  keyPlaceholder: string;
  createModel(apiKey: string, modelId: string): LanguageModel;
  /** Lists text chat models. Also the live key test: throws ProviderKeyError on a bad key. */
  listModels(apiKey: string, fetchFn?: FetchFn, signal?: AbortSignal): Promise<CatalogModel[]>;
}

export class ProviderKeyError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderKeyError';
  }
}

async function getJson(fetchFn: FetchFn, provider: string, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers, signal: signal ?? AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new ProviderKeyError(provider, 0, `Could not reach ${provider}: ${(e as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    // Surface the provider's own error message; never echo the key.
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ProviderKeyError(provider, res.status, message);
  }
  return JSON.parse(body);
}

interface ListedModel {
  id: string;
  display_name?: string;
  active?: boolean;
}

function toModels(provider: string, data: ListedModel[]): CatalogModel[] {
  return data
    .filter((m) => m.active !== false && isChatModel(m.id))
    .map((m) => toCatalogModel(provider, m.id, m.display_name))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    free: true,
    keyPlaceholder: 'gsk_...',
    createModel: (apiKey, modelId) => createGroq({ apiKey })(modelId),
    async listModels(apiKey, fetchFn = fetch, signal) {
      const j = (await getJson(fetchFn, 'groq', 'https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${apiKey}` }, signal)) as {
        data: ListedModel[];
      };
      return toModels('groq', j.data);
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    free: false,
    keyPlaceholder: 'sk-...',
    createModel: (apiKey, modelId) => createOpenAI({ apiKey })(modelId),
    async listModels(apiKey, fetchFn = fetch, signal) {
      const j = (await getJson(fetchFn, 'openai', 'https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` }, signal)) as {
        data: ListedModel[];
      };
      // OpenAI lists every model type; keep the chat families.
      return toModels('openai', j.data.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id)));
    },
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    free: false,
    keyPlaceholder: 'sk-ant-...',
    createModel: (apiKey, modelId) => createAnthropic({ apiKey })(modelId),
    async listModels(apiKey, fetchFn = fetch, signal) {
      const j = (await getJson(
        fetchFn,
        'anthropic',
        'https://api.anthropic.com/v1/models?limit=1000',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal,
      )) as { data: ListedModel[] };
      return toModels('anthropic', j.data);
    },
  },
};

export const PROVIDER_ORDER = ['groq', 'openai', 'anthropic'] as const;

export const LOCAL_PRESETS = [
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
] as const;

/**
 * Cleans a typed server address: adds http:// when no scheme is given and /v1 when no path is
 * (Ollama and LM Studio serve the OpenAI-compatible API there), and drops a trailing slash.
 * Null when it isn't an http(s) URL.
 */
export function normalizeBaseUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * True when the address is this computer (localhost, 127.0.0.0/8, ::1). Local only uses a
 * local server only at such an address, so "nothing leaves this computer" holds (decision 34).
 */
export function isLoopbackUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A local model server speaking the OpenAI chat API (Ollama, LM Studio). No key. Both enforce
 * a JSON Schema through `response_format: json_schema` (LM Studio rejects `json_object`), so
 * structured output is on.
 */
export const LocalProvider = {
  id: LOCAL_PROVIDER,
  label: 'Local',
  createModel: (baseUrl: string, modelId: string): LanguageModel =>
    createOpenAICompatible({ name: LOCAL_PROVIDER, baseURL: baseUrl, supportsStructuredOutputs: true, includeUsage: true }).chatModel(modelId),
  /** Lists the server's chat models. Also the connection test: throws ProviderKeyError when it can't be reached. */
  async listModels(baseUrl: string, fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<CatalogModel[]> {
    const j = (await getJson(fetchFn, 'the local server', `${baseUrl}/models`, {}, signal ?? AbortSignal.timeout(5_000))) as { data?: ListedModel[] };
    if (!Array.isArray(j?.data)) throw new ProviderKeyError(LOCAL_PROVIDER, 0, 'That address answered, but not with a list of models.');
    return toModels(LOCAL_PROVIDER, j.data);
  },
};
