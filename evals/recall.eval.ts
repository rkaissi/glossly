// Recall ranking (spec: Actions, Recall): fictional saved items with their entities, embedded with
// the app's local model, and selections with the items Recall should offer. Scores: selections
// whose expected items were all offered, false hits, the mean reciprocal rank of the first expected
// item, and, for every expected item, its similarity to the selection against `minSimilarity`
// (0.78), so a miss shows whether the threshold or the entities caused it. No provider calls.
//
// Needs the local embedding model, already downloaded by the app (%APPDATA%\Glossly\models), or
// GLOSSLY_MODELS_DIR:
//   pnpm exec vitest run --project evals evals/recall.eval.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, recall, Store, type EntityKind } from '@glossly/core';
import { createTransformersEmbedder } from '@glossly/core/embed';
import { limitCases, rate } from './lib';

interface Fixture {
  items: { id: string; text: string; entities: [EntityKind, string][] }[];
  cases: { id: string; text: string; expect: string[]; ok: string[] }[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'evals', 'results');
const fixture = JSON.parse(readFileSync(join(root, 'fixtures', 'recall', 'cases.json'), 'utf8')) as Fixture;
const cases = limitCases(fixture.cases);
const modelsDir = process.env.GLOSSLY_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'Glossly', 'models');
const { model, dims } = { model: 'Xenova/all-MiniLM-L6-v2', dims: 384 };
const have = existsSync(join(modelsDir, ...model.split('/')));
const vecExtensionPath = (createRequire(import.meta.url)('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

const dot = (a: Float32Array, b: Float32Array) => a.reduce((n, x, i) => n + x * b[i]!, 0);

describe('recall eval', () => {
  it.skipIf(!have)(`recall with ${model} (local)`, async () => {
    const embedder = await createTransformersEmbedder({ model, dims, cacheDir: modelsDir });
    const store = new Store(':memory:', { vecExtensionPath });
    store.ensureVectorModel(model, dims);
    const notes = store.collectionByName('Notes')!;
    const byFixture = new Map<string, string>();
    const vectors = new Map<string, Float32Array>();
    const vs = await embedder.embed(fixture.items.map((i) => i.text));
    fixture.items.forEach((it, n) => {
      const item = store.insertItem({ collection_id: notes.id, kind: 'selection', text: it.text, why: null, source_app: 'chrome.exe', window_title: 'Notes', data_json: null });
      for (const [kind, name] of it.entities) store.linkItemEntity(item.id, store.upsertEntity(kind, name));
      store.setVector(item.id, vs[n]!);
      byFixture.set(item.id, it.id);
      vectors.set(it.id, vs[n]!);
    });
    const deps = { store, embedder: () => embedder, settings: () => ({ recall: DEFAULT_SETTINGS.recall }) };
    const min = DEFAULT_SETTINGS.recall.minSimilarity;

    const rows = [];
    for (const c of cases) {
      const hits = await recall(deps, { text: c.text });
      const got = hits.map((h) => byFixture.get(h.itemId)!);
      const [q] = await embedder.embed([c.text]);
      const first = got.findIndex((g) => c.expect.includes(g));
      rows.push({
        id: c.id,
        all_found: c.expect.every((e) => got.includes(e)),
        missed: c.expect.filter((e) => !got.includes(e)),
        false_hits: got.filter((g) => !c.expect.includes(g) && !c.ok.includes(g)),
        rr: c.expect.length ? (first >= 0 ? 1 / (first + 1) : 0) : null,
        got: hits.map((h) => `${byFixture.get(h.itemId)} ${h.reason}${h.similarity ? ` ${h.similarity.toFixed(2)}` : ''}`),
        // Similarity of each expected item to the selection, against minSimilarity.
        expected_similarity: Object.fromEntries(c.expect.map((e) => [e, Number(dot(q!, vectors.get(e)!).toFixed(3))])),
        // The five most similar items, with whether each is expected, allowed, or wrong: what a threshold would let through.
        nearest: [...vectors.entries()]
          .map(([id, v]) => ({ id, sim: Number(dot(q!, v).toFixed(3)), kind: c.expect.includes(id) ? 'expect' : c.ok.includes(id) ? 'ok' : 'wrong' }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 5),
      });
      const r = rows.at(-1)!;
      console.log(`${c.id} ${r.all_found ? 'ok ' : 'MISS'} got [${r.got.join(', ')}]${r.missed.length ? ` missed ${r.missed.map((m) => `${m} (${r.expected_similarity[m]})`).join(', ')}` : ''}${r.false_hits.length ? ` false ${r.false_hits.join(',')}` : ''}`);
    }
    store.close();
    const rrs = rows.map((r) => r.rr).filter((x): x is number => x !== null);
    const sims = rows.flatMap((r) => Object.values(r.expected_similarity));
    const summary = {
      cases: rows.length,
      all_expected_found: rate(rows.map((r) => r.all_found)),
      cases_with_false_hits: rows.filter((r) => r.false_hits.length).length,
      mrr: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
      min_similarity: min,
      expected_items_under_threshold: `${sims.filter((s) => s < min).length}/${sims.length}`,
    };
    console.log('recall', JSON.stringify(summary));
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'recall.json'), JSON.stringify({ eval: 'recall', model, at: new Date().toISOString(), ...summary, results: rows }, null, 2));
    expect(rows).toHaveLength(cases.length);
  }, 600_000);
});
