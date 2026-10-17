import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ApiStyle, ProviderConnection } from '../settings';
import { isChatModel, LOCAL_PROVIDER, lookupCapabilities, toCatalogModel, type CatalogModel, type Price } from './catalog';

export type FetchFn = typeof fetch;

/** How a preset is grouped in the Add a provider list (decision 79). */
export type PresetGroup = 'free' | 'makers' | 'gateways' | 'hosts' | 'local' | 'custom';

/**
 * One entry in the Add a provider list (decision 79). Hosted presets are data: a fixed address
 * and one of the ways of talking to a model. The local presets fill the one local server
 * (`LocalProvider`); Custom asks for its own address and way of talking.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  group: PresetGroup;
  /** One line under the name. */
  blurb: string;
  keyUrl: string;
  keyPlaceholder: string;
  /** Has a free tier: shown as "Free tier". */
  free: boolean;
  /** Text goes through this service on its way to the model's maker (gateways, hosts, Custom). */
  via: boolean;
  /** Fixed address; for a local preset, its default address. */
  baseUrl?: string;
  /** Model ids to offer when the service has no model list (`GET /models` answers 404). */
  knownModels?: string[];
  /** Something to know before adding it, shown with its key field (decision 80). */
  note?: string;
}

/** How each hosted preset is reached. Custom takes its connection's own `api`. */
type Sdk = 'groq' | 'openai' | 'anthropic' | 'google' | ApiStyle;

const SDK: Record<string, Sdk> = {
  groq: 'groq',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'chat',
  deepseek: 'chat',
  moonshot: 'chat',
  minimax: 'chat',
  mistral: 'chat',
  openrouter: 'chat',
  vercel: 'chat',
  // Ramp Router has no Chat Completions endpoint, only Responses and Anthropic Messages.
  ramp: 'responses',
  together: 'chat',
  fireworks: 'chat',
  baseten: 'chat',
};

export const CUSTOM_PRESET = 'custom';

export const PRESETS: readonly ProviderPreset[] = [
  { id: 'groq', label: 'Groq', group: 'free', blurb: 'Fast open models. Free tier, then pay as you go.', keyUrl: 'https://console.groq.com/keys', keyPlaceholder: 'gsk_...', free: true, via: false },
  { id: 'google', label: 'Google Gemini', group: 'free', blurb: 'Every Gemini model. Free tier, then pay as you go.', keyUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza...', free: true, via: false, note: "On Google's free tier, Google may use what you send to improve its products; with billing on, it doesn't. Pro models need billing." },
  { id: 'openai', label: 'OpenAI', group: 'makers', blurb: 'GPT models.', keyUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-...', free: false, via: false },
  { id: 'anthropic', label: 'Anthropic', group: 'makers', blurb: 'Claude models.', keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-...', free: false, via: false },
  { id: 'xai', label: 'xAI', group: 'makers', blurb: 'Grok models.', keyUrl: 'https://console.x.ai', keyPlaceholder: 'xai-...', free: false, via: false, baseUrl: 'https://api.x.ai/v1' },
  { id: 'deepseek', label: 'DeepSeek', group: 'makers', blurb: 'DeepSeek chat and reasoning models.', keyUrl: 'https://platform.deepseek.com/api_keys', keyPlaceholder: 'sk-...', free: false, via: false, baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Kimi (Moonshot)', group: 'makers', blurb: 'Kimi models.', keyUrl: 'https://platform.moonshot.ai/console/api-keys', keyPlaceholder: 'sk-...', free: false, via: false, baseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'minimax', label: 'MiniMax', group: 'makers', blurb: 'MiniMax models.', keyUrl: 'https://platform.minimax.io', keyPlaceholder: 'Paste the key', free: false, via: false, baseUrl: 'https://api.minimax.io/v1', knownModels: ['MiniMax-M2.7', 'MiniMax-M2'] },
  { id: 'mistral', label: 'Mistral', group: 'makers', blurb: 'Mistral and Ministral models.', keyUrl: 'https://console.mistral.ai/api-keys', keyPlaceholder: 'Paste the key', free: false, via: false, baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'openrouter', label: 'OpenRouter', group: 'gateways', blurb: 'Hundreds of models from every maker.', keyUrl: 'https://openrouter.ai/keys', keyPlaceholder: 'sk-or-...', free: false, via: true, baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'vercel', label: 'Vercel AI Gateway', group: 'gateways', blurb: 'Models from many makers through Vercel.', keyUrl: 'https://vercel.com/docs/ai-gateway/authentication', keyPlaceholder: 'Paste the key', free: false, via: true, baseUrl: 'https://ai-gateway.vercel.sh/v1' },
  { id: 'ramp', label: 'Ramp Router', group: 'gateways', blurb: "Your company's models through Ramp.", keyUrl: 'https://docs.router.com/getting-started/connect', keyPlaceholder: 'Paste the Router key', free: false, via: true, baseUrl: 'https://api.router.com/v1' },
  { id: 'together', label: 'Together AI', group: 'hosts', blurb: 'Open models like Llama, Qwen, and DeepSeek.', keyUrl: 'https://api.together.xyz/settings/api-keys', keyPlaceholder: 'Paste the key', free: false, via: true, baseUrl: 'https://api.together.xyz/v1' },
  { id: 'fireworks', label: 'Fireworks', group: 'hosts', blurb: 'Open models like Llama, Qwen, and DeepSeek.', keyUrl: 'https://fireworks.ai/account/api-keys', keyPlaceholder: 'fw_...', free: false, via: true, baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { id: 'baseten', label: 'Baseten', group: 'hosts', blurb: 'Open models like Llama, Qwen, and DeepSeek.', keyUrl: 'https://app.baseten.co/settings/api_keys', keyPlaceholder: 'Paste the key', free: false, via: true, baseUrl: 'https://inference.baseten.co/v1', knownModels: ['deepseek-ai/DeepSeek-V3.1', 'openai/gpt-oss-120b'] },
  { id: 'ollama', label: 'Ollama', group: 'local', blurb: 'Free. Nothing leaves this computer.', keyUrl: 'https://ollama.com/download', keyPlaceholder: '', free: true, via: false, baseUrl: 'http://localhost:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', group: 'local', blurb: 'Free. Nothing leaves this computer.', keyUrl: 'https://lmstudio.ai', keyPlaceholder: '', free: true, via: false, baseUrl: 'http://localhost:1234/v1' },
  { id: 'local-other', label: 'Other local server', group: 'local', blurb: 'Any OpenAI-compatible server on this computer.', keyUrl: '', keyPlaceholder: '', free: true, via: false },
  { id: CUSTOM_PRESET, label: 'Custom', group: 'custom', blurb: 'Any other gateway or server, by address.', keyUrl: '', keyPlaceholder: 'Paste the key', free: false, via: true },
];

export const PRESET_BY_ID: Readonly<Record<string, ProviderPreset>> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

/** The local presets, for the local server's Connect buttons. */
export const LOCAL_PRESETS = PRESETS.filter((p) => p.group === 'local' && p.baseUrl).map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl! }));

/** The ids of the presets a key file may have been saved under before decision 79. */
export const LEGACY_PROVIDERS = ['groq', 'openai', 'anthropic'] as const;

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

/** A provider's id (for errors) and the name the user knows it by (for messages). */
interface Who {
  id: string;
  label: string;
}

const who = (conn: ProviderConnection): Who => ({ id: conn.id, label: conn.label ?? PRESET_BY_ID[conn.preset]?.label ?? conn.id });

async function request(fetchFn: FetchFn, w: Who, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: signal ?? AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new ProviderKeyError(w.id, 0, `Could not reach ${w.label}: ${(e as Error).message}`);
  }
}

/** The provider's own message from an error body; never the key. */
function errorMessage(res: Response, body: string): string {
  let message = `${res.status} ${res.statusText}`;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string };
    message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? j.detail ?? message;
  } catch {
    /* not JSON */
  }
  return message;
}

async function getJson(fetchFn: FetchFn, w: Who, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const res = await request(fetchFn, w, url, { headers }, signal);
  const body = await res.text();
  if (!res.ok) throw new ProviderKeyError(w.id, res.status, errorMessage(res, body));
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderKeyError(w.id, 0, 'That address answered, but not with a list of models.');
  }
}

interface ListedModel {
  id: string;
  display_name?: string;
  name?: string;
  active?: boolean;
  /** Together ("chat"), Vercel ("language"); absent elsewhere. */
  type?: string;
  /** OpenRouter (prompt, completion) and Vercel (input, output) per token as strings; Together per million as numbers. */
  pricing?: Record<string, unknown>;
}

/** A price as dollars per million tokens. Per-token prices (anything under $0.001) are scaled up. */
function perMillion(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 0 && n < 0.001 ? n * 1e6 : n;
}

/** The input and output price a model list gives, in dollars per million tokens, or null. */
export function listedPrice(pricing: Record<string, unknown> | undefined): Price | null {
  if (!pricing || typeof pricing !== 'object') return null;
  const input = perMillion(pricing.input ?? pricing.prompt);
  const output = perMillion(pricing.output ?? pricing.completion);
  return input === null || output === null ? null : { input, output };
}

const CHAT_TYPES = new Set(['chat', 'language', 'text']);

export function toModels(provider: string, data: ListedModel[]): CatalogModel[] {
  return data
    .filter((m) => typeof m?.id === 'string' && m.active !== false && isChatModel(m.id) && (m.type === undefined || CHAT_TYPES.has(m.type)))
    .map((m) => toCatalogModel(provider, m.id, m.display_name ?? m.name, { price: listedPrice(m.pricing) }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** The way a connection talks to its models. */
export function sdkOf(conn: Pick<ProviderConnection, 'preset' | 'api'>): Sdk {
  if (conn.preset === CUSTOM_PRESET) return conn.api ?? 'chat';
  const sdk = SDK[conn.preset];
  if (!sdk) throw new Error(`Unknown provider: ${conn.preset}`);
  return sdk;
}

/** The address a connection's requests go to, or undefined for an SDK's own default. */
export function baseUrlOf(conn: Pick<ProviderConnection, 'preset' | 'baseUrl'>): string | undefined {
  return conn.preset === CUSTOM_PRESET ? conn.baseUrl : PRESET_BY_ID[conn.preset]?.baseUrl;
}

/**
 * Builds a model on a connection. Over Chat Completions a model asks for schema-constrained
 * output only when it is known to support it; any other model gets JSON mode with the schema in
 * its instructions (`structuredOnModel`), which every compatible server takes.
 */
export function createModel(conn: ProviderConnection, apiKey: string, modelId: string): LanguageModel {
  const key = apiKey || undefined;
  const baseURL = baseUrlOf(conn);
  switch (sdkOf(conn)) {
    case 'groq':
      return createGroq({ apiKey: key })(modelId);
    case 'openai':
      return createOpenAI({ apiKey: key })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey: key, ...(baseURL && { baseURL }) })(modelId);
    case 'google':
      return createGoogle({ apiKey: key })(modelId);
    case 'responses':
      return createOpenAI({ apiKey: key, baseURL, name: conn.id }).responses(modelId);
    case 'chat':
      return createOpenAICompatible({
        name: conn.id,
        baseURL: baseURL!,
        apiKey: key,
        includeUsage: true,
        supportsStructuredOutputs: lookupCapabilities(conn.id, modelId)?.structured === 'json_schema',
      }).chatModel(modelId);
  }
}

const bearer = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

/**
 * Status of a POST with an empty body, or 0 when unreachable. 404 or 405 means the endpoint
 * isn't there; 401 or 403 a bad key; anything else (400, 422) that it is and the key passed.
 */
async function probe(fetchFn: FetchFn, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<number> {
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}', signal: signal ?? AbortSignal.timeout(10_000) });
    await res.text().catch(() => '');
    return res.status;
  } catch {
    return 0;
  }
}

const missing = (status: number) => status === 404 || status === 405 || status === 0;

/**
 * Which way a custom address talks (decision 79): Chat Completions first, then Responses, then
 * Anthropic Messages, by probing each with an empty request. No tokens are spent.
 */
export async function detectApi(baseUrl: string, apiKey: string, fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<ApiStyle> {
  if (!missing(await probe(fetchFn, `${baseUrl}/chat/completions`, bearer(apiKey), signal))) return 'chat';
  if (!missing(await probe(fetchFn, `${baseUrl}/responses`, bearer(apiKey), signal))) return 'responses';
  if (!missing(await probe(fetchFn, `${baseUrl}/messages`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal))) return 'anthropic';
  throw new ProviderKeyError(CUSTOM_PRESET, 404, "That address doesn't answer chat requests. Check the address, including any /v1 at the end.");
}

/** An OpenAI-style `GET /models`, as a bare array (Together) or under `data`. */
async function listOpenAiStyle(conn: ProviderConnection, baseUrl: string | undefined, apiKey: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<CatalogModel[]> {
  const w = who(conn);
  if (!baseUrl) throw new ProviderKeyError(conn.id, 0, 'No address saved.');
  let j: unknown;
  try {
    j = await getJson(fetchFn, w, `${baseUrl}/models`, bearer(apiKey), signal);
  } catch (e) {
    const known = PRESET_BY_ID[conn.preset]?.knownModels;
    if (!(e instanceof ProviderKeyError) || e.status !== 404 || !known) throw e;
    // No model list here: check the key on the chat endpoint, then offer the known models.
    const status = await probe(fetchFn, `${baseUrl}/chat/completions`, bearer(apiKey), signal);
    if (status === 401 || status === 403) throw new ProviderKeyError(conn.id, status, 'The key was not accepted.');
    if (missing(status)) throw new ProviderKeyError(conn.id, status, `Could not reach ${w.label}.`);
    return toModels(conn.id, known.map((id) => ({ id })));
  }
  const data = Array.isArray(j) ? j : (j as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ProviderKeyError(conn.id, 0, 'That address answered, but not with a list of models.');
  return toModels(conn.id, data as ListedModel[]);
}

/** Lists a connection's text chat models. Also the live key test: throws ProviderKeyError on a bad key. */
export async function listModels(conn: ProviderConnection, apiKey: string, fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<CatalogModel[]> {
  switch (sdkOf(conn)) {
    case 'groq': {
      const j = (await getJson(fetchFn, who(conn), 'https://api.groq.com/openai/v1/models', bearer(apiKey), signal)) as { data: ListedModel[] };
      return toModels(conn.id, j.data);
    }
    case 'openai': {
      // OpenAI lists every model type; keep the chat families.
      const models = await listOpenAiStyle(conn, 'https://api.openai.com/v1', apiKey, fetchFn, signal);
      return models.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.modelId));
    }
    case 'anthropic': {
      const base = baseUrlOf(conn) ?? 'https://api.anthropic.com/v1';
      const j = (await getJson(fetchFn, who(conn), `${base}/models?limit=1000`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal)) as {
        data: ListedModel[];
      };
      return toModels(conn.id, j.data);
    }
    case 'google': {
      const j = (await getJson(fetchFn, who(conn), 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': apiKey }, signal)) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      };
      const gemini = (j.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /^models\/gemini-/.test(m.name));
      return toModels(
        conn.id,
        gemini.map((m) => ({ id: m.name.slice('models/'.length), display_name: m.displayName })),
      );
    }
    case 'chat':
    case 'responses':
      return listOpenAiStyle(conn, baseUrlOf(conn), apiKey, fetchFn, signal);
  }
}

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
    const j = (await getJson(fetchFn, { id: LOCAL_PROVIDER, label: 'the local server' }, `${baseUrl}/models`, {}, signal ?? AbortSignal.timeout(5_000))) as { data?: ListedModel[] };
    if (!Array.isArray(j?.data)) throw new ProviderKeyError(LOCAL_PROVIDER, 0, 'That address answered, but not with a list of models.');
    return toModels(LOCAL_PROVIDER, j.data);
  },
};
