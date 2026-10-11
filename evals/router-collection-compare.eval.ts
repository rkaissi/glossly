// The router's best_collection: a free string the code fixes up (v1, before Step 16.13) against
// an enum of the user's collections in the schema (v2, now). Same 60 fixtures, same model, no
// fallback model. Measures, per method and model: calls that failed outright (the bar then
// falls back to rules for everything), calls that needed the structured retry, and for v1 how
// often the raw collection wasn't exactly one of the list (case only, or unknown, which code
// replaced with the rules' pick). Also content_type accuracy and latency, since the schema and
// prompt changed together. Writes evals/results/router-collection-compare.json.
//
// Calls the model (120 calls per model). Runs only with GROQ_API_KEY and GLOSSLY_COMPARE=1;
// GLOSSLY_COMPARE_MODELS is a comma list (default: Qwen 3.8, then gpt-oss-20b, Rayan's Fast and fallback).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECTIONS,
  DecisionsSchema,
  extractFeatures,
  formatDecisionPrompt,
  LlmStructuredDecision,
  ruleCollection,
  type ContentType,
  type ModelRef,
  type SelectionContext,
} from '@glossly/core';
import { countedLlm, errorLabel, groqKey, median, withRateLimitRetry } from './lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = Boolean(groqKey()) && process.env.GLOSSLY_COMPARE === '1';
const models = (process.env.GLOSSLY_COMPARE_MODELS ?? 'groq:qwen/qwen3.8-27b,groq:openai/gpt-oss-20b').split(',').map((m) => m.trim()) as ModelRef[];
const promptV1 = readFileSync(join(root, 'evals', 'legacy', 'router-decision-v1.md'), 'utf8');
const collections = [...DEFAULT_COLLECTIONS];

interface Case {
  id: string;
  context: SelectionContext;
  expected: { content_type: ContentType };
}
const cases: Case[] = readdirSync(join(root, 'fixtures'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(root, 'fixtures', f), 'utf8')) as { cases: Case[] }).cases);

interface Row {
  id: string;
  ok: boolean;
  error: string | null;
  attempts: number;
  ms: number;
  /** v1 only: the collection exactly as the model wrote it. */
  raw_collection: string | null;
  /** v1: exact, case (fixed by code), or unknown (replaced by the rules' pick). v2: exact or failed. */
  collection_status: 'exact' | 'case' | 'unknown' | 'failed';
  collection: string | null;
  type_ok: boolean;
}

describe('router: best_collection as a string (v1) against an enum (v2)', () => {
  for (const modelRef of models) {
    it.skipIf(!run)(`compares both on ${cases.length} cases with ${modelRef}`, async () => {
      const counted = countedLlm(modelRef);
      const v2 = new LlmStructuredDecision(counted.llm);
      const out: Record<'v1' | 'v2', Row[]> = { v1: [], v2: [] };

      for (const c of cases) {
        const input = { context: c.context, features: extractFeatures(c.context), collections };
        for (const method of ['v1', 'v2'] as const) {
          let t = performance.now();
          try {
            const d = await withRateLimitRetry(
              async () => {
                if (method === 'v2') return { ...(await v2.decide(input)), raw: null as string | null };
                // v1 exactly as before: the old schema (string collection, provider field) and prompt, then the code fix-up.
                const o = await counted.llm.structured(
                  { role: 'decision', action: 'router', instructions: promptV1, prompt: formatDecisionPrompt(input), temperature: 0, maxOutputTokens: 200 },
                  DecisionsSchema,
                );
                const known = collections.find((x) => x.toLowerCase() === o.best_collection.trim().toLowerCase());
                return { ...o, best_collection: known ?? ruleCollection(o.content_type, input.features, collections), raw: o.best_collection };
              },
              () => {
                counted.reset();
                t = performance.now();
              },
            );
            const status: Row['collection_status'] =
              method === 'v2' || d.raw === d.best_collection ? 'exact' : collections.some((x) => x.toLowerCase() === d.raw!.trim().toLowerCase()) ? 'case' : 'unknown';
            out[method].push({
              id: c.id,
              ok: true,
              error: null,
              attempts: counted.calls().attempts,
              ms: Math.round(performance.now() - t),
              raw_collection: d.raw,
              collection_status: status,
              collection: d.best_collection,
              type_ok: d.content_type === c.expected.content_type,
            });
          } catch (e) {
            out[method].push({
              id: c.id,
              ok: false,
              error: `${errorLabel(e)} ${(e as Error).message.slice(0, 140)}`,
              attempts: counted.calls().attempts,
              ms: Math.round(performance.now() - t),
              raw_collection: null,
              collection_status: 'failed',
              collection: null,
              type_ok: false,
            });
          }
        }
      }

      const sum = (rows: Row[]) => ({
        cases: rows.length,
        failed: rows.filter((r) => !r.ok).length,
        failure_rate: rows.filter((r) => !r.ok).length / rows.length,
        needed_retry: rows.filter((r) => r.ok && r.attempts > 1).length,
        collection_case_fixed: rows.filter((r) => r.collection_status === 'case').length,
        collection_unknown_replaced: rows.filter((r) => r.collection_status === 'unknown').length,
        type_accuracy: rows.filter((r) => r.type_ok).length / rows.length,
        median_ms: median(rows.filter((r) => r.ok).map((r) => r.ms)),
        over_600ms: rows.filter((r) => r.ok && r.ms > 600).length,
        errors: rows.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`),
      });
      const agree = out.v1.filter((r, i) => r.ok && out.v2[i]!.ok && r.collection === out.v2[i]!.collection).length;
      const both = out.v1.filter((r, i) => r.ok && out.v2[i]!.ok).length;
      const summary = { eval: 'router-collection-compare', model: modelRef, at: new Date().toISOString(), v1: sum(out.v1), v2: sum(out.v2), same_collection: `${agree}/${both}` };
      console.log(JSON.stringify(summary, null, 2));
      mkdirSync(join(root, 'evals', 'results'), { recursive: true });
      const name = modelRef.replace(/[^a-z0-9]+/gi, '-');
      writeFileSync(join(root, 'evals', 'results', `router-collection-compare-${name}.json`), JSON.stringify({ ...summary, results: out }, null, 2));
      expect(out.v1).toHaveLength(cases.length);
    }, 3_600_000);
  }
});
