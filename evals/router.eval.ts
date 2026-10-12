import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assignSlots,
  DEFAULT_COLLECTIONS,
  DEFAULT_SETTINGS,
  decideByRules,
  extractFeatures,
  LlmStructuredDecision,
  type ContentType,
  type ContextualAction,
  type Decisions,
  type SelectionContext,
} from '@glossly/core';
import { countedLlm, evalModel, groqKey, limitCases, median, RateLimitStop, withRateLimitRetry } from './lib';

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
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');
const resultsDir = join(root, 'evals', 'results');
const TARGET = 0.85;

const allCases: Case[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as { cases: Case[] }).cases);

// GLOSSLY_EVAL_LIMIT takes cases in turn from each fixture file (Step 21: start small).
const cases = limitCases(allCases);
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

function report<E extends object>(name: string, results: CaseResult[], extra: E = {} as E) {
  const n = results.length;
  const summary = {
    eval: 'router',
    mode: name,
    at: new Date().toISOString(),
    cases: n,
    type_accuracy: results.filter((r) => r.type_ok).length / n,
    slot_accuracy: results.filter((r) => r.slots_ok).length / n,
    target_type_accuracy: TARGET,
    median_ms: median(results.map((r) => r.ms)) ?? 0,
    ...extra,
    results,
  };
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `router-${name}.json`), JSON.stringify(summary, null, 2));
  return summary;
}

describe('router eval', () => {
  it('has the 60 fixture cases with unique ids', () => {
    expect(allCases).toHaveLength(60);
    expect(new Set(allCases.map((c) => c.id)).size).toBe(60);
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

  // The Decision model on today's Groq catalog (decision 60); override with GLOSSLY_EVAL_MODEL.
  const modelRef = evalModel('groq:qwen/qwen3.8-27b');

  it.skipIf(!groqKey())(`llm (${modelRef}): content_type accuracy >= ${TARGET * 100}%`, async () => {
    const counted = countedLlm(modelRef);
    const decision = new LlmStructuredDecision(counted.llm);
    const results: CaseResult[] = [];
    let stopped: string | null = null;
    for (const c of cases) {
      const features = extractFeatures(c.context);
      let t = performance.now();
      try {
        const d = await withRateLimitRetry(
          () => decision.decide({ context: c.context, features, collections }),
          () => {
            counted.reset();
            t = performance.now();
          },
        );
        const u = counted.calls();
        results.push({ ...score(c, d, performance.now() - t), input_tokens: u.inputTokens, output_tokens: u.outputTokens });
      } catch (e) {
        if (e instanceof RateLimitStop) {
          stopped = e.message;
          break;
        }
        const fallback = decideByRules({ context: c.context, features, collections });
        const err = e as Error;
        results.push({ ...score(c, fallback, performance.now() - t), error: `${err.name}: ${err.message.slice(0, 120)}` });
      }
    }
    // The rules on exactly the cases the model answered, for the pre-agreed rule (HANDOFF, Step 21).
    const answered = new Set(results.map((r) => r.id));
    const rules = cases.filter((c) => answered.has(c.id)).map((c) => score(c, decideByRules({ context: c.context, features: extractFeatures(c.context), collections }), 0));
    const total = counted.total();
    const s = report('llm', results, {
      model: modelRef,
      errors: results.filter((r) => r.error).length,
      over_budget: results.filter((r) => r.ms > DEFAULT_SETTINGS.router.decisionTimeoutMs).length,
      rules_type_accuracy_same_cases: rules.filter((r) => r.type_ok).length / Math.max(rules.length, 1),
      rules_slot_accuracy_same_cases: rules.filter((r) => r.slots_ok).length / Math.max(rules.length, 1),
      calls: total.attempts,
      input_tokens: total.inputTokens,
      output_tokens: total.outputTokens,
      stopped,
    });
    expect(stopped, 'stopped on rate limits').toBeNull();
    // Errored cases are scored on the rules fallback, so many errors would hide a broken model call.
    expect(s.errors).toBeLessThanOrEqual(cases.length * 0.1);
    expect(s.type_accuracy).toBeGreaterThanOrEqual(TARGET);
  }, 3_600_000);
});
