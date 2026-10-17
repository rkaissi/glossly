import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type ModelRef, type Settings } from '../settings';
import { costFromPrice, isChatModel, lookupCapabilities, parseRef, pickDefault, toCatalogModel, toRef } from './catalog';
import { AiSdkLlm, isFallbackError, LOCAL_UNREACHABLE_MESSAGE, privacyChain, REASONING_ROOM, retryAfterMs, type LlmCall } from './llm';
import { detectApi, isLoopbackUrl, listedPrice, listModels, LocalProvider, normalizeBaseUrl, ProviderKeyError } from './providers';
import { measuredSpeed, type SpeedSample } from './speed';
import { modelChain, updateLocalModel, updateRoles } from './roles';
import { LlmError } from './types';
import { answerAfterUnaskedSave, rememberTool } from '../actions/ask';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = { unified: 'stop' as const, raw: 'stop' };

function apiError(status: number, responseHeaders?: Record<string, string>) {
  return new APICallError({ message: `HTTP ${status}`, url: 'https://x', requestBodyValues: {}, statusCode: status, isRetryable: false, responseHeaders });
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

function failingModel(status: number, headers?: Record<string, string>) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw apiError(status, headers);
    },
    doGenerate: async () => {
      throw apiError(status, headers);
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

function llmWith(models: Record<ModelRef, MockLanguageModelV4>, settings: LlmSettings, keys = ['groq', 'openai', 'anthropic'], clock = { t: 0 }) {
  const fallbacks: unknown[] = [];
  const calls: LlmCall[] = [];
  const llm = new AiSdkLlm({
    now: () => clock.t,
    onCall: (c) => calls.push(c),
    settings: () => settings,
    apiKey: (p) => (keys.includes(p) ? 'k' : null),
    createModel: (ref) => {
      const m = models[ref];
      if (!m) throw new Error(`no mock for ${ref}`);
      return m;
    },
    onFallback: (info) => fallbacks.push(info),
  });
  return { llm, fallbacks, calls };
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
    expect(fallbacks).toEqual([{ action: 'chat', role: 'chat', from: 'anthropic:claude-sonnet-5-5', to: 'openai:gpt-5-mini', status: 429, reason: 'rate_limit' }]);
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

describe('rate-limit memory (decision 60)', () => {
  const Schema = z.object({ answer: z.string(), n: z.number() });
  const FAST = { model: 'groq:qwen/qwen3.8-27b', fallback: 'groq:openai/gpt-oss-20b', manual: false };

  it('skips a model that got a 429 until retry-after, then tries it again, and a success clears it', async () => {
    const clock = { t: 0 };
    const limited = failingModel(429, { 'retry-after': '30' });
    const backup = jsonModel(...Array.from({ length: 4 }, () => '{"answer":"b","n":1}'));
    const { llm, fallbacks } = llmWith({ 'groq:qwen/qwen3.8-27b': limited, 'groq:openai/gpt-oss-20b': backup }, roles({ fast: FAST }), ['groq'], clock);
    const seen: string[] = [];
    const ask = () => llm.structured({ role: 'fast', action: 'who', instructions: 'i', prompt: 'p', onFallback: (to) => seen.push(to) }, Schema);
    await ask();
    expect(llm.limitedUntil('groq:qwen/qwen3.8-27b')).toBe(30_000);
    clock.t = 29_000;
    await ask();
    expect(limited.doGenerateCalls).toHaveLength(1);
    expect(fallbacks.map((f) => (f as { reason: string }).reason)).toEqual(['rate_limit', 'remembered']);
    expect(seen).toEqual(['groq:openai/gpt-oss-20b', 'groq:openai/gpt-oss-20b']);
    // At the time it lapses; the next 429 brings a fresh time.
    clock.t = 30_000;
    expect(llm.limitedUntil('groq:qwen/qwen3.8-27b')).toBeNull();
    await ask();
    expect(limited.doGenerateCalls).toHaveLength(2);
    expect(llm.limitedUntil('groq:qwen/qwen3.8-27b')).toBe(60_000);
  });

  it('tries a limited model anyway when every model in the chain is limited', async () => {
    const clock = { t: 0 };
    const a = failingModel(429, { 'retry-after': '20' });
    const b = failingModel(429, { 'retry-after': '20' });
    const { llm } = llmWith({ 'groq:qwen/qwen3.8-27b': a, 'groq:openai/gpt-oss-20b': b }, roles({ fast: FAST }), ['groq'], clock);
    await expect(llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema)).rejects.toMatchObject({ statusCode: 429 });
    await expect(llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema)).rejects.toMatchObject({ statusCode: 429 });
    expect([a.doGenerateCalls.length, b.doGenerateCalls.length]).toEqual([2, 2]);
  });

  it('a success on a remembered model clears it', async () => {
    const clock = { t: 0 };
    let fail = true;
    const flaky = new MockLanguageModelV4({
      doGenerate: async () => {
        if (fail) throw apiError(429, { 'retry-after': '5' });
        return { content: [{ type: 'text' as const, text: '{"answer":"a","n":1}' }], finishReason: finish, usage, warnings: [] };
      },
    });
    const { llm } = llmWith({ 'groq:qwen/qwen3.8-27b': flaky, 'groq:openai/gpt-oss-20b': jsonModel('{"answer":"b","n":1}') }, roles({ fast: FAST }), ['groq'], clock);
    await llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema);
    fail = false;
    clock.t = 6_000;
    await llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema);
    expect(llm.limitedUntil('groq:qwen/qwen3.8-27b')).toBeNull();
  });

  it('reads retry-after in seconds or as a date, then Groq\'s token reset, else 10 s, within 1 s to an hour', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(retryAfterMs(apiError(429, { 'retry-after': '7' }), now)).toBe(7000);
    expect(retryAfterMs(apiError(429, { 'Retry-After': 'Mon, 12 Oct 2026 10:00:42 GMT' }), now)).toBe(42_000);
    expect(retryAfterMs(apiError(429, { 'x-ratelimit-reset-tokens': '2m59.5s' }), now)).toBe(179_500);
    expect(retryAfterMs(apiError(429, { 'x-ratelimit-reset-tokens': '450ms' }), now)).toBe(1000);
    expect(retryAfterMs(apiError(429), now)).toBe(10_000);
    expect(retryAfterMs(apiError(429, { 'retry-after': '86400' }), now)).toBe(3_600_000);
  });
});

describe('call log (decision 61)', () => {
  const Schema = z.object({ answer: z.string(), n: z.number() });

  it('reports every try with its prompt, answer, model, and the model it fell back from', async () => {
    const { llm, calls } = llmWith(
      { 'groq:qwen/qwen3.8-27b': failingModel(429), 'groq:openai/gpt-oss-20b': jsonModel('{"answer":"b","n":4}') },
      roles({ fast: { model: 'groq:qwen/qwen3.8-27b', fallback: 'groq:openai/gpt-oss-20b', manual: false } }),
      ['groq'],
    );
    await llm.structured({ role: 'fast', action: 'who', instructions: 'i', prompt: 'Who is Casey Lin?' }, Schema);
    expect(calls.map((c) => [c.model, c.status, c.error, c.fallbackFrom])).toEqual([
      ['groq:qwen/qwen3.8-27b', 'error', '429', null],
      ['groq:openai/gpt-oss-20b', 'ok', null, 'groq:qwen/qwen3.8-27b'],
    ]);
    expect(calls[1]).toMatchObject({ action: 'who', role: 'fast', prompt: 'Who is Casey Lin?', response: '{"answer":"b","n":4}' });
    expect(calls[1]!.usage?.input).toBe(10);
  });

  it('logs a streamed call with the text it streamed', async () => {
    const { llm, calls } = llmWith({ 'anthropic:claude-sonnet-5-5': textModel(['Hi ', 'there']) }, roles({ chat: { ...CHAT, fallback: null } }));
    await collect(llm.stream({ role: 'chat', action: 'reply', instructions: 'i', prompt: 'p' }).textStream);
    expect(calls).toMatchObject([{ action: 'reply', model: 'anthropic:claude-sonnet-5-5', status: 'ok', response: 'Hi there' }]);
  });

  it('logs an answer that failed validation with the raw text', async () => {
    const { llm, calls } = llmWith({ 'openai:gpt-5-mini': jsonModel('nope', '{"answer":"a","n":1}') }, roles({ fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false } }));
    await llm.structured({ role: 'fast', instructions: 'i', prompt: 'p' }, Schema);
    expect(calls.map((c) => [c.status, c.response])).toEqual([
      ['invalid_output', 'nope'],
      ['ok', '{"answer":"a","n":1}'],
    ]);
  });

  it('gives reasoning models room for their reasoning on top of the output cap (decision 60)', async () => {
    const Small = z.object({ answer: z.string(), n: z.number() });
    const oss = jsonModel('{"answer":"a","n":1}');
    const qwen = jsonModel('{"answer":"a","n":1}');
    const { llm } = llmWith({ 'groq:openai/gpt-oss-20b': oss, 'groq:qwen/qwen3.8-27b': qwen }, roles({ fast: { model: 'groq:openai/gpt-oss-20b', fallback: null, manual: false }, chat: { model: 'groq:qwen/qwen3.8-27b', fallback: null, manual: false } }), ['groq']);
    await llm.structured({ role: 'fast', instructions: 'i', prompt: 'p', maxOutputTokens: 200 }, Small);
    await llm.structured({ role: 'chat', instructions: 'i', prompt: 'p', maxOutputTokens: 200 }, Small);
    expect(oss.doGenerateCalls[0]!.maxOutputTokens).toBe(200 + REASONING_ROOM);
    expect(qwen.doGenerateCalls[0]!.maxOutputTokens).toBe(200);
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
    // Decision: the fastest structured model, schema-native first; its fallback from another provider.
    expect(u.roles.decision).toEqual({ model: 'anthropic:claude-haiku-4-5', fallback: 'groq:llama-3.1-8b-instant', manual: false });
  });

  it('with only the current Groq catalog, gives the router Qwen and keeps Fast off it (decision 60)', () => {
    const live = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'].map((id) => toCatalogModel('groq', id));
    const u = updateRoles(DEFAULT_SETTINGS.roles, live);
    expect(u.roles.decision).toEqual({ model: 'groq:qwen/qwen3.8-27b', fallback: 'groq:openai/gpt-oss-20b', manual: false });
    expect(u.roles.fast).toEqual({ model: 'groq:openai/gpt-oss-20b', fallback: 'groq:openai/gpt-oss-120b', manual: false });
    // Chat: the smartest, then the next smartest.
    expect(u.roles.chat).toEqual({ model: 'groq:openai/gpt-oss-120b', fallback: 'groq:qwen/qwen3.8-27b', manual: false });
    // Automatic roles follow the defaults, so an install from before moves over on its own.
    const before = { ...DEFAULT_SETTINGS.roles, fast: { model: 'groq:qwen/qwen3.8-27b', fallback: 'groq:openai/gpt-oss-20b', manual: false } };
    expect(updateRoles(before, live).roles).toEqual(u.roles);
    // A hand pick stays, "Use Fast model" for Decision included.
    const picked = { ...u.roles, decision: { model: null, fallback: null, manual: true }, fast: { model: 'groq:qwen/qwen3.8-27b', fallback: null, manual: true } };
    expect(updateRoles(picked, live).roles.decision).toEqual({ model: null, fallback: null, manual: true });
    expect(updateRoles(picked, live).roles.fast.model).toBe('groq:qwen/qwen3.8-27b');
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
    const models = await listModels(
      { id: 'groq', preset: 'groq' },
      'gsk_test',
      fetchJson(200, { data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'llama-3.1-8b-instant' }, { id: 'old', active: false }] }, seen),
    );
    expect(models.map((m) => m.ref)).toEqual(['groq:llama-3.1-8b-instant', 'groq:openai/gpt-oss-20b']);
    expect(models[0]!.capabilities?.structured).toBe('json');
    expect(seen.headers).toEqual({ Authorization: 'Bearer gsk_test' });
  });

  it('keeps only chat families from OpenAI and uses Anthropic display names', async () => {
    const o = await listModels({ id: 'openai', preset: 'openai' }, 'k', fetchJson(200, { data: [{ id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'babbage-002' }, { id: 'omni-moderation' }] }));
    expect(o.map((m) => m.modelId)).toEqual(['gpt-5-mini']);
    const a = await listModels({ id: 'anthropic', preset: 'anthropic' }, 'k', fetchJson(200, { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }));
    expect(a[0]!.displayName).toBe('Claude Sonnet 5.5');
  });

  it('surfaces the provider’s error message on a bad key, without the key', async () => {
    const err = await listModels({ id: 'groq', preset: 'groq' }, 'gsk_secret', fetchJson(401, { error: { message: 'Invalid API Key' } })).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderKeyError);
    expect(err).toMatchObject({ provider: 'groq', status: 401, message: 'Invalid API Key' });
    expect(String(err.message)).not.toContain('gsk_secret');

    const net = await listModels({ id: 'openai', preset: 'openai' }, 'k', (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch).catch((e) => e);
    expect(net).toMatchObject({ status: 0, message: 'Could not reach OpenAI: offline' });
  });
});

describe('added providers (decision 79)', () => {
  type Call = { url: string; method: string; headers: Record<string, string> };
  /** Answers by URL suffix; anything unlisted is a 404. Records each request. */
  const routes = (map: Record<string, [number, unknown]>, calls: Call[] = []) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
      const hit = Object.entries(map).find(([suffix]) => url.endsWith(suffix));
      const [status, body] = hit ? hit[1] : [404, { error: { message: 'Not found' } }];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it('lists a gateway at its own address with the key, and reads its prices', async () => {
    const calls: Call[] = [];
    const models = await listModels(
      { id: 'openrouter', preset: 'openrouter' },
      'sk-or-test',
      routes(
        {
          '/models': [
            200,
            {
              data: [
                { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 mini', pricing: { prompt: '0.00000025', completion: '0.000002' } },
                { id: 'moonshotai/kimi-k2', pricing: { prompt: '0.0000006', completion: '0.0000025' } },
                { id: 'openai/text-embedding-3-small' },
              ],
            },
          ],
        },
        calls,
      ),
    );
    expect(calls[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/models', headers: { Authorization: 'Bearer sk-or-test' } });
    expect(models.map((m) => m.ref)).toEqual(['openrouter:moonshotai/kimi-k2', 'openrouter:openai/gpt-5-mini']);
    const mini = models[1]!;
    expect(mini.displayName).toBe('OpenAI: GPT-5 mini');
    expect(mini.price).toEqual({ input: 0.25, output: 2 });
    // Known through its vendor prefix: the maker's capabilities, so it can be picked for a role.
    expect(mini.capabilities).toMatchObject({ structured: 'json_schema', speed: 'fast', cost: 'low' });
  });

  it('reads a bare-array model list (Together) and keeps only chat types', async () => {
    const models = await listModels(
      { id: 'together', preset: 'together' },
      'k',
      routes({
        '/models': [
          200,
          [
            { id: 'deepseek-ai/DeepSeek-V3', display_name: 'DeepSeek V3', type: 'chat', pricing: { input: 1.25, output: 1.25 } },
            { id: 'black-forest-labs/FLUX.1', type: 'image' },
          ],
        ],
      }),
    );
    expect(models.map((m) => m.modelId)).toEqual(['deepseek-ai/DeepSeek-V3']);
    expect(models[0]!.price).toEqual({ input: 1.25, output: 1.25 });
    expect(models[0]!.capabilities?.structured).toBe('json');
  });

  it('offers known models when a service has no model list, after checking the key', async () => {
    const calls: Call[] = [];
    const models = await listModels({ id: 'minimax', preset: 'minimax' }, 'k', routes({ '/chat/completions': [400, { error: 'bad request' }] }, calls));
    expect(models.map((m) => m.modelId)).toEqual(['MiniMax-M2', 'MiniMax-M2.7']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.minimax.io/v1/models', 'POST https://api.minimax.io/v1/chat/completions']);
    const bad = await listModels({ id: 'minimax', preset: 'minimax' }, 'k', routes({ '/chat/completions': [401, {}] })).catch((e) => e);
    expect(bad).toMatchObject({ status: 401, message: 'The key was not accepted.' });
  });

  it('finds how a custom address talks, without spending tokens', async () => {
    expect(await detectApi('https://llm.example.com/v1', 'k', routes({ '/chat/completions': [400, {}] }))).toBe('chat');
    // A Responses-only gateway: no Chat Completions endpoint.
    expect(await detectApi('https://llm.example.com/v1', 'k', routes({ '/responses': [400, {}] }))).toBe('responses');
    expect(await detectApi('https://llm.example.com/v1', 'k', routes({ '/messages': [400, {}] }))).toBe('anthropic');
    await expect(detectApi('https://llm.example.com/v1', 'k', routes({}))).rejects.toBeInstanceOf(ProviderKeyError);
  });

  it('lists Gemini models that generate text', async () => {
    const calls: Call[] = [];
    const models = await listModels(
      { id: 'google', preset: 'google' },
      'AIza-test',
      routes(
        {
          '/models?pageSize=1000': [
            200,
            {
              models: [
                { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
              ],
            },
          ],
        },
        calls,
      ),
    );
    expect(calls[0]!.headers).toEqual({ 'x-goog-api-key': 'AIza-test' });
    expect(models.map((m) => m.ref)).toEqual(['google:gemini-3-flash']);
    expect(models[0]!.capabilities).toMatchObject({ structured: 'json_schema', cost: 'low' });
  });

  it('looks models up under their maker only for providers without entries of their own', () => {
    expect(lookupCapabilities('ramp', 'anthropic:claude-sonnet-5-5')?.tier).toBe(4);
    expect(lookupCapabilities('custom-1', 'x-ai/grok-4-fast')?.speed).toBe('fast');
    // Groq has its own entries, so its "openai/..." ids are Groq's, not OpenAI's.
    expect(lookupCapabilities('groq', 'openai/gpt-oss-20b')?.reasoning).toBe('low');
    expect(lookupCapabilities('groq', 'openai/gpt-5-mini')).toBeNull();
    expect(lookupCapabilities('openrouter', 'meta-llama/llama-3.3-70b-instruct')).toBeNull();
  });

  it("prefers the maker's own key over a gateway's copy of the same model", () => {
    const viaGateway = toCatalogModel('openrouter', 'openai/gpt-5-mini');
    const direct = toCatalogModel('openai', 'gpt-5-mini');
    expect(pickDefault('fast', [viaGateway, direct])?.ref).toBe('openai:gpt-5-mini');
  });
});

describe('Gemini and gateway picks (decision 80)', () => {
  const gemini = ['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'].map((id) =>
    toCatalogModel('google', id),
  );

  it('never picks Pro, previews, or the retired 2.x family on its own, but still labels them', () => {
    expect(lookupCapabilities('google', 'gemini-2.5-pro')).toMatchObject({ auto: false, cost: 'high' });
    expect(lookupCapabilities('google', 'gemini-3-flash-preview')?.auto).toBe(false);
    expect(pickDefault('chat', gemini)?.modelId).toBe('gemini-3.5-flash');
    expect(pickDefault('decision', gemini)?.modelId).toBe('gemini-3.5-flash-lite');
    // A full tie goes to the newer version of the same family.
    expect(pickDefault('fast', [toCatalogModel('google', 'gemini-3.1-flash-lite'), toCatalogModel('google', 'gemini-3.5-flash-lite')])?.modelId).toBe('gemini-3.5-flash-lite');
  });

  it('breaks a Chat tie on speed, measured speed included', () => {
    expect(lookupCapabilities('google', 'gemini-3.8-flash')?.speed).toBe('slow');
    const slowed = [toCatalogModel('google', 'gemini-3.5-flash', undefined, { measured: 'slow' }), toCatalogModel('google', 'gemini-3.8-flash', undefined, { measured: 'fast' })];
    expect(pickDefault('chat', slowed)?.modelId).toBe('gemini-3.8-flash');
  });

  it("looks a gateway's unprefixed ids up under each maker (Ramp)", () => {
    expect(lookupCapabilities('ramp', 'gpt-5.6-luna')).toMatchObject({ cost: 'low', speed: 'fast' });
    expect(lookupCapabilities('ramp', 'claude-haiku-4-5')?.tier).toBe(2);
    expect(lookupCapabilities('ramp', 'some-house-model')).toBeNull();
  });
});

describe('model labels (decision 79)', () => {
  it('turns listed prices into cost, per token or per million', () => {
    expect(listedPrice({ prompt: '0.0000003', completion: '0.0000012' })).toEqual({ input: 0.3, output: 1.2 });
    expect(listedPrice({ input: 3, output: 15 })).toEqual({ input: 3, output: 15 });
    expect(listedPrice({ input: 'n/a' })).toBeNull();
    expect(costFromPrice({ input: 0.25, output: 2 })).toBe('low');
    expect(costFromPrice({ input: 1.25, output: 10 })).toBe('medium');
    expect(costFromPrice({ input: 15, output: 75 })).toBe('high');
  });

  it('gives an untested model a cost from its price, and a known one keeps its own', () => {
    const untested = toCatalogModel('openrouter', 'someone/new-model', undefined, { price: { input: 0.1, output: 0.4 } });
    expect(untested).toMatchObject({ capabilities: null, cost: 'low' });
    const known = toCatalogModel('anthropic', 'claude-opus-5-1', undefined, { price: { input: 0.1, output: 0.1 } });
    expect(known.cost).toBe('high');
  });

  it('measures speed from wait plus time per token, judged at a typical answer', () => {
    const fit = (wait: number, perToken: number, lengths: number[]): SpeedSample[] => lengths.map((output) => ({ ms: wait + perToken * output, output }));
    const mixed = [20, 40, 60, 300, 500, 80, 100, 250, 400, 30];
    expect(measuredSpeed(fit(300, 2, mixed))).toBe('fast');
    expect(measuredSpeed(fit(1500, 15, mixed))).toBe('medium');
    expect(measuredSpeed(fit(2000, 50, mixed))).toBe('slow');
    // Too few calls: no measured speed yet.
    expect(measuredSpeed(fit(300, 2, mixed.slice(0, 9)))).toBeNull();
    // All the same length (the router's short answers): the median time stands in.
    expect(measuredSpeed(Array.from({ length: 12 }, () => ({ ms: 450, output: 47 })))).toBe('fast');
  });

  it('puts a measured speed in place of the listed one', () => {
    const m = toCatalogModel('anthropic', 'claude-haiku-4-5', undefined, { measured: 'slow' });
    expect(m.capabilities?.speed).toBe('slow');
    expect(m.measured).toBe('slow');
  });
});

describe('AiSdkLlm.stream with a tool', () => {
  it('runs Ask\'s remember tool once, says what it saved, and makes no second call', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'remember', input: JSON.stringify({ note: 'Maya prefers  mornings', collection: 'notes', asked: true }) },
      { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
    ];
    const model = new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(parts) } });
    const { llm } = llmWith({ [CHAT.model]: model }, roles({ chat: { ...CHAT, fallback: null } }));
    const saved: [string, string, boolean][] = [];
    const tools = {
      remember: rememberTool({
        collections: ['Notes', 'Reading'],
        suggested: 'Reading',
        save: (note, collection, asked) => {
          saved.push([note, collection, asked]);
          return { collection, updated: false };
        },
      }),
    };
    const r = llm.stream({ role: 'chat', action: 'ask', instructions: 'i', prompt: 'p', tools, continueAfterTools: answerAfterUnaskedSave });
    expect(await collect(r.textStream)).toBe('Saved to Notes: "Maya prefers mornings"');
    expect(saved).toEqual([['Maya prefers mornings', 'Notes', true]]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('saves a memory nobody asked for quietly, then lets the model answer (decision 78)', async () => {
    const steps: LanguageModelV4StreamPart[][] = [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'remember', input: JSON.stringify({ note: 'Casey Lin is vegetarian', collection: 'Notes', asked: false }) },
        { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
      ],
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Try the veggie place.' },
        { type: 'text-end', id: 't' },
        { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
      ],
    ];
    let call = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(steps[Math.min(call++, 1)]!) }) });
    const { llm } = llmWith({ [CHAT.model]: model }, roles({ chat: { ...CHAT, fallback: null } }));
    const saved: boolean[] = [];
    const tools = { remember: rememberTool({ collections: ['Notes'], suggested: 'Notes', save: (_n, collection, asked) => (saved.push(asked), { collection, updated: false }) }) };
    const r = llm.stream({ role: 'chat', action: 'ask', instructions: 'i', prompt: 'p', tools, continueAfterTools: answerAfterUnaskedSave });
    expect(await collect(r.textStream)).toBe('Try the veggie place.');
    expect(saved).toEqual([false]);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it('decides when to answer after saving', () => {
    expect(answerAfterUnaskedSave({ text: '', toolInputs: [{ asked: false }] })).toBe(true);
    expect(answerAfterUnaskedSave({ text: 'Here you go.', toolInputs: [{ asked: false }] })).toBe(false);
    expect(answerAfterUnaskedSave({ text: '', toolInputs: [{ asked: true }] })).toBe(false);
    expect(answerAfterUnaskedSave({ text: '', toolInputs: [{ asked: false }, { asked: true }] })).toBe(false);
  });
});

describe('token counts (decision 48)', () => {
  it('reports each structured try and each finished stream, with the action', async () => {
    const seen: unknown[] = [];
    const m = jsonModel('{"answer":"yes"}', '{"answer":"yes","n":2}');
    const llm = new AiSdkLlm({
      settings: () => roles({ fast: { model: 'openai:gpt-5-mini', fallback: null, manual: false }, chat: CHAT }),
      apiKey: () => 'k',
      createModel: (ref) => (ref === 'openai:gpt-5-mini' ? m : textModel(['hi'])),
      onUsage: (u) => seen.push(u),
    });
    await llm.structured({ role: 'fast', action: 'who', instructions: 'i', prompt: 'p' }, z.object({ answer: z.string(), n: z.number() }));
    await collect(llm.stream({ role: 'chat', action: 'reply', instructions: 'i', prompt: 'p' }).textStream);
    const row = { input: 10, output: 5, cached: 0, reasoning: 0, ms: expect.any(Number) };
    expect(seen).toEqual([
      { action: 'who', role: 'fast', provider: 'openai', model: 'openai:gpt-5-mini', ...row },
      { action: 'who', role: 'fast', provider: 'openai', model: 'openai:gpt-5-mini', ...row },
      { action: 'reply', role: 'chat', provider: 'anthropic', model: CHAT.model, ...row },
    ]);
  });
});

describe('reasoning effort on streams (decision 48)', () => {
  it('asks a reasoning model for the requested effort, and leaves other models alone', async () => {
    const oss = textModel(['a']);
    const qwen = textModel(['b']);
    const { llm } = llmWith(
      { 'groq:openai/gpt-oss-120b': oss, 'groq:qwen/qwen3.8-27b': qwen },
      roles({ chat: { model: 'groq:openai/gpt-oss-120b', fallback: null, manual: false }, fast: { model: 'groq:qwen/qwen3.8-27b', fallback: null, manual: false } }),
    );
    await collect(llm.stream({ role: 'chat', action: 'reply', instructions: 'i', prompt: 'p', reasoning: 'low' }).textStream);
    await collect(llm.stream({ role: 'fast', instructions: 'i', prompt: 'p', reasoning: 'low' }).textStream);
    expect(oss.doStreamCalls[0]!.providerOptions).toMatchObject({ groq: { reasoningEffort: 'low' } });
    expect(qwen.doStreamCalls[0]!.providerOptions?.groq).toBeUndefined();
  });
});
