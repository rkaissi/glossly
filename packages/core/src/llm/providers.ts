import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { isChatModel, toCatalogModel, type CatalogModel } from './catalog';

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
