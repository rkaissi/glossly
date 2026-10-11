import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type ModelRef, type Settings } from '../settings';
import { isChatModel, lookupCapabilities, parseRef, pickDefault, toCatalogModel, toRef } from './catalog';
import { AiSdkLlm, isFallbackError, LOCAL_UNREACHABLE_MESSAGE, privacyChain } from './llm';
import { isLoopbackUrl, LocalProvider, normalizeBaseUrl, PROVIDERS, ProviderKeyError } from './providers';
import { modelChain, updateLocalModel, updateRoles } from './roles';
import { LlmError } from './types';
import { rememberTool } from '../actions/ask';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = { unified: 'stop' as const, raw: 'stop' };

function apiError(status: number) {
  return new APICallError({ message: `HTTP ${status}`, url: 'https://x', requestBodyValues: {}, statusCode: status, isRetryable: false });
}

function textModel(chunks: string[], tailError?: unknown) {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
  ];
  if (tailError) parts.push({ type: 'error', error: tailError });
  else parts.push({ type: 'text-end', id: 't' }, { type: 'finish', usage, finishReason: finish });
  return new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(parts) } });
}

function failingModel(status: number) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw apiError(status);
    },
    doGenerate: async () => {
      throw apiError(status);
    },
  });
}

function jsonModel(...texts: string[]) {
  return new MockLanguageModelV4({
    doGenerate: texts.map((text) => ({ content: [{ type: 'text' as const, text }], finishReason: finish, usage, warnings: [] })),
  });
}

type LlmSettings = Pick<Settings, 'roles' | 'actionModels' | 'privacy' | 'local'>;

function roles(over: Partial<Settings['roles']>): LlmSettings {
  return { roles: { ...DEFAULT_SETTINGS.roles, ...over }, actionModels: {}, privacy: 'all', local: DEFAULT_SETTINGS.local };
}

function llmWith(models: Record<ModelRef, MockLanguageModelV4>, settings: LlmSettings, keys = ['groq', 'openai', 'anthropic']) {
  const fallbacks: unknown[] = [];
  const llm = new AiSdkLlm({
    settings: () => settings,
    apiKey: (p) => (keys.includes(p) ? 'k' : null),
    createModel: (ref) => {
      const m = models[ref];
      if (!m) throw new Error(`no mock for ${ref}`);
      return m;
    },
    onFallback: (info) => fallbacks.push(info),
  });
  return { llm, fallbacks };
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let s = '';
  for await (const t of it) s += t;
  return s;
}

const CHAT = { model: 'anthropic:claude-sonnet-5-5', fallback: 'openai:gpt-5-mini', manual: false };

describe('AiSdkLlm.stream', () => {
  it('streams text and reports the model', async () => {
    const { llm } = llmWith({ 'anthropic:claude-sonnet-5-5': textModel(['Hel', 'lo']), 'openai:gpt-5-mini': textModel(['x']) }, roles({ chat: CHAT }));
    const r = llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' });
    expect(await collect(r.textStream)).toBe('Hello');
    expect(await r.model).toBe('anthropic:claude-sonnet-5-5');
  });

  it('falls back on 429 before the first token', async () => {
    const { llm, fallbacks } = llmWith(
      { 'anthropic:claude-sonnet-5-5': failingModel(429), 'openai:gpt-5-mini': textModel(['ok']) },
      roles({ chat: CHAT }),
    );
    const r = llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' });
    expect(await collect(r.textStream)).toBe('ok');
    expect(await r.model).toBe('openai:gpt-5-mini');
    expect(fallbacks).toEqual([{ from: 'anthropic:claude-sonnet-5-5', to: 'openai:gpt-5-mini', status: 429 }]);
  });

  it('does not fall back after the first token', async () => {
    const backup = textModel(['never']);
    const { llm, fallbacks } = llmWith(
      { 'anthropic:claude-sonnet-5-5': textModel(['partial'], apiError(503)), 'openai:gpt-5-mini': backup },
      roles({ chat: CHAT }),
    );
    const r = llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const t of r.textStream) seen.push(t);
      })(),
    ).rejects.toMatchObject({ name: 'LlmError', code: 'provider', statusCode: 503 });
    expect(seen).toEqual(['partial']);
    expect(fallbacks).toEqual([]);
    expect(backup.doStreamCalls).toHaveLength(0);
  });

  it('does not fall back on a 401', async () => {
    const { llm } = llmWith({ 'anthropic:claude-sonnet-5-5': failingModel(401), 'openai:gpt-5-mini': textModel(['x']) }, roles({ chat: CHAT }));
    await expect(collect(llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' }).textStream)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('errors with no_model when no key matches', async () => {
    const { llm } = llmWith({}, roles({ chat: CHAT }), []);
    expect(llm.hasModel('chat')).toBe(false);
    await expect(collect(llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' }).textStream)).rejects.toMatchObject({ code: 'no_model' });
  });
});

describe('AiSdkLlm with Local only on', () => {
  it('with no local model, refuses streams and structured calls before building or calling any model', async () => {
    const chat = textModel(['never']);
    const fast = jsonModel('{"answer":"yes","n":1}');
    const built: string[] = [];
    const settings: LlmSettings = { ...roles({ chat: CHAT, fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }), privacy: 'local' };
    const llm = new AiSdkLlm({
      settings: () => settings,
      apiKey: () => 'k',
      createModel: (ref) => {
        built.push(ref);
        return ref.startsWith('openai') ? fast : chat;
      },
    });
    const r = llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' });
    await expect(collect(r.textStream)).rejects.toMatchObject({ name: 'LlmError', code: 'local_only' });
    await expect(r.model).rejects.toMatchObject({ code: 'local_only' });
    await expect(llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, z.object({ answer: z.string() }))).rejects.toMatchObject({
      code: 'local_only',
    });
    expect(built).toEqual([]);
    expect(chat.doStreamCalls).toHaveLength(0);
    expect(fast.doGenerateCalls).toHaveLength(0);

    // Turning it off takes effect on the next call.
    settings.privacy = 'all';
    expect(await collect(llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' }).textStream)).toBe('never');
  });

  const LOCAL = 'local:qwen3:8b';
  const localKeys = (p: string) => (p === 'local' ? '' : 'k');

  it('sends every role to the Local only model, never to a cloud one', async () => {
    const local = textModel(['from local']);
    const built: string[] = [];
    const settings: LlmSettings = {
      ...roles({ chat: CHAT, fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }),
      privacy: 'local',
      local: { baseUrl: 'http://localhost:11434/v1', model: LOCAL, manual: false },
    };
    const llm = new AiSdkLlm({
      settings: () => settings,
      apiKey: localKeys,
      createModel: (ref) => {
        built.push(ref);
        return local;
      },
    });
    expect(llm.hasModel('chat')).toBe(true);
    expect(llm.hasModel('decision')).toBe(true);
    expect(await collect(llm.stream({ role: 'chat', instructions: 'i', prompt: 'p' }).textStream)).toBe('from local');
    expect(built).toEqual([LOCAL]);
  });

  it('keeps a local model picked for a role, and skips its cloud fallback', () => {
    const settings: LlmSettings = {
      ...roles({ chat: { model: 'local:llama3.3:70b', fallback: 'groq:openai/gpt-oss-120b', manual: true } }),
      privacy: 'local',
      local: { baseUrl: 'http://127.0.0.1:1234/v1', model: LOCAL, manual: false },
    };
    expect(privacyChain(settings, 'chat')).toEqual(['local:llama3.3:70b', LOCAL]);
    expect(privacyChain({ ...settings, privacy: 'all' }, 'chat')).toEqual(['local:llama3.3:70b', 'groq:openai/gpt-oss-120b']);
  });

  it('never uses a server on another machine under Local only', () => {
    const settings: LlmSettings = { ...roles({}), privacy: 'local', local: { baseUrl: 'http://192.168.1.20:11434/v1', model: LOCAL, manual: false } };
    const llm = new AiSdkLlm({ settings: () => settings, apiKey: localKeys, createModel: () => textModel(['x']) });
    expect(llm.hasModel('fast')).toBe(false);
    expect(privacyChain(settings, 'fast')).toEqual([]);
    // Under All models the same server is just another provider.
    const all: LlmSettings = { ...settings, privacy: 'all', roles: { ...settings.roles, fast: { model: LOCAL, fallback: null, manual: true } } };
    expect(privacyChain(all, 'fast')).toEqual([LOCAL]);
  });

  it('says the local server is not running when a call to it gets no answer', async () => {
    const down = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: 'Cannot connect to API: fetch failed', url: 'http://localhost:11434/v1', requestBodyValues: {}, isRetryable: true });
      },
    });
    const settings: LlmSettings = { ...roles({}), privacy: 'local', local: { baseUrl: 'http://localhost:11434/v1', model: LOCAL, manual: false } };
    const llm = new AiSdkLlm({ settings: () => settings, apiKey: localKeys, createModel: () => down });
    await expect(llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, z.object({ a: z.string() }))).rejects.toMatchObject({
      code: 'provider',
      message: LOCAL_UNREACHABLE_MESSAGE,
    });
  });
});

describe('local server', () => {
  it('normalizes typed addresses', () => {
    expect(normalizeBaseUrl('localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://localhost:1234/')).toBe('http://localhost:1234/v1');
    expect(normalizeBaseUrl(' http://127.0.0.1:8080/api/v1/ ')).toBe('http://127.0.0.1:8080/api/v1');
    expect(normalizeBaseUrl('ftp://example.com')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
  });

  it('counts only this computer as local', () => {
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.20:11434/v1')).toBe(false);
    expect(isLoopbackUrl('https://llm.example.com/v1')).toBe(false);
    expect(isLoopbackUrl('http://localhost.example.com/v1')).toBe(false);
  });

  it('lists the server chat models with the generic local capabilities', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:8b' }, { id: 'nomic-embed-text:latest' }, { id: 'gemma3:4b' }] }));
    }) as unknown as typeof fetch;
    const models = await LocalProvider.listModels('http://localhost:11434/v1', fetchFn);
    expect(urls).toEqual(['http://localhost:11434/v1/models']);
    expect(models.map((m) => m.ref)).toEqual(['local:gemma3:4b', 'local:qwen3:8b']);
    expect(models[0]!.capabilities).toMatchObject({ structured: 'json_schema', tools: false, speed: 'slow' });
  });

  it('reports a server that is not running', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(LocalProvider.listModels('http://localhost:11434/v1', fetchFn)).rejects.toMatchObject({ status: 0 });
  });

  it('fills the Local only model from the local catalog and keeps a hand pick', () => {
    const models = [toCatalogModel('groq', 'qwen/qwen3.8-27b'), toCatalogModel('local', 'qwen3:8b'), toCatalogModel('local', 'gemma3:4b')];
    const base = { baseUrl: 'http://localhost:11434/v1', model: null, manual: false };
    expect(updateLocalModel(base, models).local.model).toBe('local:gemma3:4b');
    expect(updateLocalModel({ ...base, model: 'local:qwen3:8b', manual: true }, models).changed).toBe(false);
    const gone = updateLocalModel({ ...base, model: 'local:llama3:8b', manual: true }, models);
    expect(gone.local).toMatchObject({ model: 'local:gemma3:4b', manual: false });
    expect(gone.notices).toHaveLength(1);
  });

  it('never makes a local model the automatic fallback of a cloud one', () => {
    const models = [toCatalogModel('groq', 'qwen/qwen3.8-27b'), toCatalogModel('local', 'qwen3:8b')];
    const u = updateRoles(DEFAULT_SETTINGS.roles, models);
    expect(u.roles.fast.model).toBe('groq:qwen/qwen3.8-27b');
    expect(u.roles.fast.fallback).toBeNull();
    expect(u.roles.chat.fallback).toBeNull();
    // With only a local server, it fills the roles.
    expect(updateRoles(DEFAULT_SETTINGS.roles, [models[1]!]).roles.chat.model).toBe('local:qwen3:8b');
  });
});

describe('AiSdkLlm.structured', () => {
  const Schema = z.object({ answer: z.string(), n: z.number() });

  it('uses native schema output on json_schema models', async () => {
    const m = jsonModel('{"answer":"yes","n":1}');
    const { llm } = llmWith({ 'openai:gpt-5-mini': m }, roles({ fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }));
    expect(await llm.structured({ role: 'fast', instructions: 'Be terse.', prompt: 'p' }, Schema)).toEqual({ answer: 'yes', n: 1 });
    const call = m.doGenerateCalls[0]!;
    expect(call.responseFormat).toMatchObject({ type: 'json', schema: expect.any(Object) });
    expect(JSON.stringify(call.prompt)).not.toContain('JSON Schema');
  });

  it('retries once with the validation error, then gives up', async () => {
    const m = jsonModel('{"answer":"yes"}', '{"answer":"yes","n":2}');
    const { llm } = llmWith({ 'openai:gpt-5-mini': m }, roles({ fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }));
    expect(await llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema)).toEqual({ answer: 'yes', n: 2 });
    expect(m.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(m.doGenerateCalls[1]!.prompt)).toContain('Your previous answer was not valid');

    const bad = jsonModel('nope', 'still nope');
    const { llm: llm2 } = llmWith({ 'openai:gpt-5-mini': bad }, roles({ fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }));
    await expect(llm2.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('puts the schema in the instructions and disables structured outputs in Groq JSON mode', async () => {
    const m = jsonModel('{"answer":"a","n":3}');
    const { llm } = llmWith(
      { 'groq:llama-3.1-8b-instant': m },
      roles({ fast: { model: 'groq:llama-3.1-8b-instant', fallback: null, manual: false } }),
    );
    expect(await llm.structured({ role: 'fast', instructions: 'Be terse.', prompt: 'p' }, Schema)).toEqual({ answer: 'a', n: 3 });
    const call = m.doGenerateCalls[0]!;
    expect(JSON.stringify(call.prompt)).toContain('JSON Schema');
    expect(call.providerOptions).toMatchObject({ groq: { structuredOutputs: false } });
  });

  it('sets the reasoning effort from capabilities on reasoning models', async () => {
    const m = jsonModel('{"answer":"a","n":3}');
    const { llm } = llmWith({ 'groq:qwen/qwen3.8-27b': m }, roles({ fast: { model: 'groq:qwen/qwen3.8-27b', fallback: null, manual: false } }));
    await llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema);
    expect(m.doGenerateCalls[0]!.providerOptions).toMatchObject({ groq: { structuredOutputs: true, reasoningEffort: 'none' } });
  });

  it('falls back on 5xx, and the decision role uses the Fast model by default', async () => {
    const { llm, fallbacks } = llmWith(
      { 'groq:openai/gpt-oss-20b': failingModel(500), 'openai:gpt-5-mini': jsonModel('{"answer":"b","n":4}') },
      roles({ fast: { model: 'groq:openai/gpt-oss-20b', fallback: 'openai:gpt-5-mini', manual: false } }),
    );
    expect(await llm.structured({ role: 'decision', instructions: 'i', prompt: 'p' }, Schema)).toEqual({ answer: 'b', n: 4 });
    expect(fallbacks).toHaveLength(1);
  });

  it('reports cancellation as aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { llm } = llmWith({ 'openai:gpt-5-mini': jsonModel('{}') }, roles({ fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }));
    await expect(llm.structured({ role: 'fast', instructions: 'i', prompt: 'p', signal: ctl.signal }, Schema)).rejects.toBeInstanceOf(LlmError);
  });
});

describe('isFallbackError', () => {
  it('is true for 429 and 5xx only', () => {
    expect([429, 500, 503, 400, 401, 404].map((s) => isFallbackError(apiError(s)))).toEqual([true, true, true, false, false, false]);
    expect(isFallbackError(new Error('x'))).toBe(false);
  });
});

describe('catalog', () => {
  it('filters non-chat models and looks up capabilities', () => {
    expect(isChatModel('whisper-large-v3')).toBe(false);
    expect(isChatModel('text-embedding-3-small')).toBe(false);
    expect(isChatModel('llama-3.1-8b-instant')).toBe(true);
    expect(lookupCapabilities('groq', 'llama-3.1-8b-instant')?.structured).toBe('json');
    expect(lookupCapabilities('openai', 'gpt-5-mini')?.structured).toBe('json_schema');
    expect(lookupCapabilities('openai', 'some-new-model')).toBeNull();
    expect(parseRef(toRef('groq', 'openai/gpt-oss-20b'))).toEqual({ provider: 'groq', modelId: 'openai/gpt-oss-20b' });
  });

  it('picks cheap fast structured models for Fast and the highest tier for Chat, never untested ones', () => {
    const models = [
      toCatalogModel('groq', 'llama-3.1-8b-instant'),
      toCatalogModel('groq', 'openai/gpt-oss-120b'),
      toCatalogModel('anthropic', 'claude-sonnet-5-5'),
      toCatalogModel('anthropic', 'claude-opus-5-1'),
      toCatalogModel('openai', 'mystery-9000'),
    ];
    expect(pickDefault('fast', models)?.ref).toBe('groq:llama-3.1-8b-instant');
    expect(pickDefault('chat', models)?.ref).toBe('anthropic:claude-opus-5-1');
    expect(pickDefault('chat', [toCatalogModel('openai', 'mystery-9000')])).toBeNull();
  });
});

describe('roles', () => {
  const groq = [toCatalogModel('groq', 'llama-3.1-8b-instant'), toCatalogModel('groq', 'openai/gpt-oss-120b')];
  const anthropic = [toCatalogModel('anthropic', 'claude-haiku-4-5'), toCatalogModel('anthropic', 'claude-sonnet-5-5')];

  it('fills empty roles with a fallback from another provider', () => {
    const u = updateRoles(DEFAULT_SETTINGS.roles, [...groq, ...anthropic]);
    expect(u.changed).toBe(true);
    expect(u.roles.fast).toEqual({ model: 'groq:llama-3.1-8b-instant', fallback: 'anthropic:claude-haiku-4-5', manual: false });
    expect(u.roles.chat.model).toBe('anthropic:claude-sonnet-5-5');
    expect(parseRef(u.roles.chat.fallback!).provider).toBe('groq');
    expect(u.roles.decision.model).toBeNull();
  });

  it('with only the current Groq catalog, puts the small Qwen model on Fast and spreads fallbacks across models', () => {
    const live = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'].map((id) => toCatalogModel('groq', id));
    const u = updateRoles(DEFAULT_SETTINGS.roles, live);
    expect(u.roles.fast).toEqual({ model: 'groq:qwen/qwen3.8-27b', fallback: 'groq:openai/gpt-oss-20b', manual: false });
    expect(u.roles.chat.model).toBe('groq:openai/gpt-oss-120b');
    expect(u.roles.chat.fallback).not.toBe('groq:openai/gpt-oss-120b');
  });

  it('keeps a manual pick that is still available, and replaces one that went away with a notice', () => {
    const manual = { ...DEFAULT_SETTINGS.roles, chat: { model: 'groq:openai/gpt-oss-120b', fallback: null, manual: true } };
    const kept = updateRoles(manual, [...groq, ...anthropic]);
    expect(kept.roles.chat).toEqual({ model: 'groq:openai/gpt-oss-120b', fallback: null, manual: true });

    const gone = updateRoles(manual, anthropic);
    expect(gone.roles.chat.model).toBe('anthropic:claude-sonnet-5-5');
    expect(gone.roles.chat.manual).toBe(false);
    expect(gone.notices[0]).toContain('openai/gpt-oss-120b is no longer available');
  });

  it('builds the model chain with action overrides and the Fast model for decisions', () => {
    const s = {
      roles: {
        fast: { model: 'groq:a', fallback: 'openai:b', manual: false },
        chat: { model: 'anthropic:c', fallback: null, manual: false },
        decision: { model: null, fallback: null, manual: false },
      },
      actionModels: { ask: 'openai:d' },
    };
    expect(modelChain('decision', s)).toEqual(['groq:a', 'openai:b']);
    expect(modelChain('chat', s, 'ask')).toEqual(['openai:d', 'anthropic:c']);
    expect(modelChain('chat', s, 'reply')).toEqual(['anthropic:c']);
  });
});

describe('providers.listModels', () => {
  const fetchJson = (status: number, body: unknown, seen?: { url?: string; headers?: Record<string, string> }) =>
    (async (url: string, init?: RequestInit) => {
      if (seen) {
        seen.url = url;
        seen.headers = init?.headers as Record<string, string>;
      }
      return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Unauthorized' });
    }) as unknown as typeof fetch;

  it('lists chat models only, sorted, with capabilities', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const models = await PROVIDERS.groq!.listModels(
      'gsk_test',
      fetchJson(200, { data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'llama-3.1-8b-instant' }, { id: 'old', active: false }] }, seen),
    );
    expect(models.map((m) => m.ref)).toEqual(['groq:llama-3.1-8b-instant', 'groq:openai/gpt-oss-20b']);
    expect(models[0]!.capabilities?.structured).toBe('json');
    expect(seen.headers).toEqual({ Authorization: 'Bearer gsk_test' });
  });

  it('keeps only chat families from OpenAI and uses Anthropic display names', async () => {
    const o = await PROVIDERS.openai!.listModels('k', fetchJson(200, { data: [{ id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'babbage-002' }, { id: 'omni-moderation' }] }));
    expect(o.map((m) => m.modelId)).toEqual(['gpt-5-mini']);
    const a = await PROVIDERS.anthropic!.listModels('k', fetchJson(200, { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }));
    expect(a[0]!.displayName).toBe('Claude Sonnet 5.5');
  });

  it('surfaces the provider’s error message on a bad key, without the key', async () => {
    const err = await PROVIDERS.groq!.listModels('gsk_secret', fetchJson(401, { error: { message: 'Invalid API Key' } })).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderKeyError);
    expect(err).toMatchObject({ provider: 'groq', status: 401, message: 'Invalid API Key' });
    expect(String(err.message)).not.toContain('gsk_secret');

    const net = await PROVIDERS.openai!.listModels('k', (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch).catch((e) => e);
    expect(net).toMatchObject({ status: 0, message: 'Could not reach openai: offline' });
  });
});

describe('AiSdkLlm.stream with a tool', () => {
  it('runs Ask\'s remember tool once, says what it saved, and makes no second call', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'remember', input: JSON.stringify({ note: 'Maya prefers  mornings', collection: 'notes' }) },
      { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
    ];
    const model = new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(parts) } });
    const { llm } = llmWith({ [CHAT.model]: model }, roles({ chat: { ...CHAT, fallback: null } }));
    const saved: [string, string][] = [];
    const tools = {
      remember: rememberTool({
        collections: ['Notes', 'Reading'],
        suggested: 'Reading',
        save: (note, collection) => {
          saved.push([note, collection]);
          return { collection };
        },
      }),
    };
    const r = llm.stream({ role: 'chat', action: 'ask', instructions: 'i', prompt: 'p', tools });
    expect(await collect(r.textStream)).toBe('Saved to Notes: "Maya prefers mornings"');
    expect(saved).toEqual([['Maya prefers mornings', 'Notes']]);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
