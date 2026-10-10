import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AiSdkLlm,
  assignSlots,
  DEFAULT_COLLECTIONS,
  DEFAULT_SETTINGS,
  decideByRules,
  extractFeatures,
  LlmStructuredDecision,
  parseRef,
  PROVIDERS,
  type ContentType,
  type ContextualAction,
  type Decisions,
  type SelectionContext,
} from '@glossly/core';

interface Case {
  id: string;
  context: SelectionContext;
  expected: { content_type: ContentType; slots: ContextualAction[] };
}

interface CaseResult {
  id: string;
  expected_type: ContentType;
  got_type: ContentType;
  expected_slots: ContextualAction[];
  got_slots: ContextualAction[];
  type_ok: boolean;
  slots_ok: boolean;
  ms: number;
  error?: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');
const resultsDir = join(root, 'evals', 'results');
const TARGET = 0.85;

const cases: Case[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as { cases: Case[] }).cases);

const collections = [...DEFAULT_COLLECTIONS];

function score(c: Case, d: Decisions, ms: number): CaseResult {
  const slots = assignSlots(d, extractFeatures(c.context), DEFAULT_SETTINGS.router);
  const got = [slots.slot3?.action, slots.slot4?.action].filter((a): a is ContextualAction => Boolean(a));
  const exp = [...c.expected.slots].sort();
  return {
    id: c.id,
    expected_type: c.expected.content_type,
    got_type: d.content_type,
    expected_slots: c.expected.slots,
    got_slots: got,
    type_ok: d.content_type === c.expected.content_type,
    slots_ok: JSON.stringify([...got].sort()) === JSON.stringify(exp),
    ms,
  };
}

function report(name: string, results: CaseResult[], extra: Record<string, unknown> = {}) {
  const n = results.length;
  const summary = {
    eval: 'router',
    mode: name,
    at: new Date().toISOString(),
    cases: n,
    type_accuracy: results.filter((r) => r.type_ok).length / n,
    slot_accuracy: results.filter((r) => r.slots_ok).length / n,
    target_type_accuracy: TARGET,
    median_ms: [...results.map((r) => r.ms)].sort((a, b) => a - b)[n >> 1] ?? 0,
    ...extra,
    results,
  };
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `router-${name}.json`), JSON.stringify(summary, null, 2));
  return summary;
}

describe('router eval', () => {
  it('has the 60 fixture cases with unique ids', () => {
    expect(cases).toHaveLength(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(60);
  });

  it(`rules: content_type accuracy >= ${TARGET * 100}%`, () => {
    const results = cases.map((c) => {
      const t = performance.now();
      const d = decideByRules({ context: c.context, features: extractFeatures(c.context), collections });
      return score(c, d, performance.now() - t);
    });
    const s = report('rules', results);
    expect(s.type_accuracy).toBeGreaterThanOrEqual(TARGET);
  });

  const groqKey = process.env.GROQ_API_KEY;
  const modelRef = process.env.GLOSSLY_EVAL_MODEL ?? 'groq:llama-3.1-8b-instant';

  it.skipIf(!groqKey)(`llm (${modelRef}): content_type accuracy >= ${TARGET * 100}%`, async () => {
    const llm = new AiSdkLlm({
      settings: () => ({ ...DEFAULT_SETTINGS, roles: { ...DEFAULT_SETTINGS.roles, fast: { model: modelRef, fallback: null, manual: true } } }),
      apiKey: (p) => (p === 'groq' ? groqKey! : (process.env[`${p.toUpperCase()}_API_KEY`] ?? null)),
      createModel: (ref, key) => PROVIDERS[parseRef(ref).provider]!.createModel(key, parseRef(ref).modelId),
    });
    const decision = new LlmStructuredDecision(llm);
    const results: CaseResult[] = [];
    for (const c of cases) {
      const features = extractFeatures(c.context);
      const t = performance.now();
      try {
        const d = await decision.decide({ context: c.context, features, collections });
        results.push(score(c, d, performance.now() - t));
      } catch (e) {
        const fallback = decideByRules({ context: c.context, features, collections });
        results.push({ ...score(c, fallback, performance.now() - t), error: (e as Error).name });
      }
    }
    const s = report('llm', results, {
      model: modelRef,
      errors: results.filter((r) => r.error).length,
      over_budget: results.filter((r) => r.ms > DEFAULT_SETTINGS.router.decisionTimeoutMs).length,
    });
    expect(s.type_accuracy).toBeGreaterThanOrEqual(TARGET);
  });
});
