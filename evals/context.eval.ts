// What Ask and Reply get from saved data (decision 77): fictional people, tasks, events, and notes,
// embedded with the app's local model, and conversations with what should come back of each kind.
// Scores per kind: cases with every expected row found, false hits, and, for tuning the thresholds
// in `settings.context`, how close expected and wrong rows were to the best query text.
// No provider calls.
//
// Needs the local embedding model, already downloaded by the app (%APPDATA%\Glossly\models), or
// GLOSSLY_MODELS_DIR:
//   pnpm exec vitest run --project evals evals/context.eval.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CalendarRepo,
  contextDocs,
  DEFAULT_SETTINGS,
  isoNow,
  PeopleRepo,
  retrieveContext,
  Store,
  syncContext,
  type CommitmentOwner,
  type Relationship,
} from '@glossly/core';
import { createTransformersEmbedder } from '@glossly/core/embed';
import { limitCases, rate } from './lib';

type Kind = 'people' | 'tasks' | 'events' | 'notes';
const KINDS: Kind[] = ['people', 'tasks', 'events', 'notes'];

interface Fixture {
  now: string;
  people: { id: string; name: string; relationship: Relationship; note: string }[];
  tasks: { id: string; owner: CommitmentOwner; person?: string; text: string; due?: string; done?: string }[];
  events: { id: string; title: string; start: string; end?: string; location?: string; attendees?: string[] }[];
  notes: { id: string; text: string }[];
  cases: { id: string; texts: string[]; given?: string[]; expect: Partial<Record<Kind, string[]>>; ok: Partial<Record<Kind, string[]>> }[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'evals', 'results');
const fixture = JSON.parse(readFileSync(join(root, 'fixtures', 'context', 'cases.json'), 'utf8')) as Fixture;
const cases = limitCases(fixture.cases);
const modelsDir = process.env.GLOSSLY_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'Glossly', 'models');
const { model, dims } = { model: 'Xenova/all-MiniLM-L6-v2', dims: 384 };
const have = existsSync(join(modelsDir, ...model.split('/')));
const vecExtensionPath = (createRequire(import.meta.url)('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

const local = (s: string) => isoNow(new Date(s));
const dot = (a: Float32Array, b: Float32Array) => a.reduce((n, x, i) => n + x * b[i]!, 0);
const THRESHOLD: Record<Exclude<Kind, 'notes'>, number> = {
  people: DEFAULT_SETTINGS.context.personSimilarity,
  tasks: DEFAULT_SETTINGS.context.taskSimilarity,
  events: DEFAULT_SETTINGS.context.eventSimilarity,
};

describe('context eval', () => {
  it.skipIf(!have)(`context with ${model} (local)`, async () => {
    const now = new Date(fixture.now);
    const embedder = await createTransformersEmbedder({ model, dims, cacheDir: modelsDir });
    const store = new Store(':memory:', { vecExtensionPath });
    store.ensureVectorModel(model, dims);
    const people = new PeopleRepo(store, () => isoNow(now));
    const calendar = new CalendarRepo(store);

    // Fixture ids <-> database ids, per kind.
    const toFixture = new Map<string, string>();
    const personId = new Map<string, string>();
    for (const p of fixture.people) {
      const row = people.create({ name: p.name, relationship: p.relationship, note: p.note });
      personId.set(p.id, row.id);
      toFixture.set(row.id, p.id);
    }
    const byName = new Map(fixture.people.map((p) => [p.name, personId.get(p.id)!]));
    for (const t of fixture.tasks) {
      const row = people.addCommitment({ person_id: t.person ? personId.get(t.person)! : null, owner: t.owner, text: t.text, due_at: t.due ?? null });
      if (t.done) {
        people.setCommitmentStatus(row.id, 'done');
        store.db.prepare('UPDATE commitments SET completed_at = ? WHERE id = ?').run(local(t.done), row.id);
      }
      toFixture.set(row.id, t.id);
    }
    for (const e of fixture.events) {
      const attendees = e.attendees ?? [];
      const row = calendar.add(
        { title: e.title, starts_at: local(e.start), ends_at: e.end ? local(e.end) : null, all_day: false, location: e.location ?? null, attendees, personIds: attendees.map((a) => byName.get(a)).filter((x): x is string => Boolean(x)) },
        null,
      );
      toFixture.set(row.id, e.id);
    }
    const notesCol = store.collectionByName('Notes')!;
    const noteVectors = await embedder.embed(fixture.notes.map((n) => n.text));
    fixture.notes.forEach((n, i) => {
      const item = store.insertItem({ collection_id: notesCol.id, kind: 'note', text: n.text, why: null, source_app: null, window_title: null, data_json: null });
      store.setVector(item.id, noteVectors[i]!);
      toFixture.set(item.id, n.id);
    });
    await syncContext({ store, embedder: () => embedder });

    // Every row's vector by fixture id, for the similarity diagnostics.
    const docs = contextDocs(store);
    const docVectors = await embedder.embed(docs.map((d) => d.text));
    const vectorOf = new Map<string, { kind: Kind; v: Float32Array }>();
    const KIND_OF = { person: 'people', task: 'tasks', event: 'events' } as const;
    docs.forEach((d, i) => vectorOf.set(toFixture.get(d.id)!, { kind: KIND_OF[d.kind], v: docVectors[i]! }));
    fixture.notes.forEach((n, i) => vectorOf.set(n.id, { kind: 'notes', v: noteVectors[i]! }));

    const deps = { store, people, calendar, embedder: () => embedder, settings: () => ({ recall: DEFAULT_SETTINGS.recall, context: DEFAULT_SETTINGS.context }) };
    const rows = [];
    for (const c of cases) {
      const t0 = performance.now();
      const r = await retrieveContext(deps, { texts: c.texts, personIds: (c.given ?? []).map((g) => personId.get(g)!), now });
      const ms = Math.round(performance.now() - t0);
      const got: Record<Kind, string[]> = {
        people: r.people.map((x) => `${toFixture.get(x.id)} ${x.reason}${x.similarity ? ` ${x.similarity.toFixed(2)}` : ''}`),
        tasks: r.tasks.map((x) => `${toFixture.get(x.id)} ${x.reason}${x.similarity ? ` ${x.similarity.toFixed(2)}` : ''}`),
        events: r.events.map((x) => `${toFixture.get(x.id)} ${x.reason}${x.similarity ? ` ${x.similarity.toFixed(2)}` : ''}`),
        notes: r.notes.map((x) => `${toFixture.get(x.itemId)} ${x.reason}${x.similarity ? ` ${x.similarity.toFixed(2)}` : ''}`),
      };
      const ids = (k: Kind) => got[k].map((g) => g.split(' ')[0]!);
      const queryVectors = await embedder.embed(c.texts);
      const best = (id: string) => Math.max(...queryVectors.map((q) => dot(q, vectorOf.get(id)!.v)));
      const perKind = Object.fromEntries(
        KINDS.map((k) => {
          const expected = c.expect[k] ?? [];
          const allowed = [...expected, ...(c.ok[k] ?? [])];
          return [
            k,
            {
              all_found: expected.every((e) => ids(k).includes(e)),
              missed: expected.filter((e) => !ids(k).includes(e)).map((e) => `${e} (${best(e).toFixed(2)})`),
              false_hits: got[k].filter((g) => !allowed.includes(g.split(' ')[0]!)),
              // The closest rows of this kind by meaning, marked expect, ok, or wrong: what a threshold lets through.
              nearest: [...vectorOf.entries()]
                .filter(([, x]) => x.kind === k)
                .map(([id]) => ({ id, sim: Number(best(id).toFixed(3)), as: expected.includes(id) ? 'expect' : allowed.includes(id) ? 'ok' : 'wrong' }))
                .sort((a, b) => b.sim - a.sim)
                .slice(0, 3),
            },
          ];
        }),
      ) as Record<Kind, { all_found: boolean; missed: string[]; false_hits: string[]; nearest: { id: string; sim: number; as: string }[] }>;
      rows.push({ id: c.id, texts: c.texts, ms, days: r.days, got, ...perKind });
      const bad = KINDS.filter((k) => !perKind[k].all_found || perKind[k].false_hits.length);
      console.log(
        `${c.id} ${bad.length ? 'MISS' : 'ok  '} ${ms}ms ${KINDS.map((k) => `${k}[${got[k].join(', ')}]`).join(' ')}${bad.map((k) => ` | ${k}: missed ${perKind[k].missed.join(',') || '-'} false ${perKind[k].false_hits.join(',') || '-'}`).join('')}`,
      );
    }
    store.close();

    // Thresholds: the lowest similarity of an expected row that only meaning could find (it came
    // back as "similar", or was missed), and the highest of a wrong row that still came back.
    // Wrong rows the date filters dropped don't count; `nearest` in the results file shows them.
    const tuning = Object.fromEntries(
      (['people', 'tasks', 'events'] as const).map((k) => {
        const exp = rows.flatMap((r) =>
          r[k].nearest.filter((n) => n.as === 'expect' && (r[k].missed.some((m) => m.startsWith(`${n.id} `)) || r.got[k].some((g) => g.startsWith(`${n.id} similar `)))).map((n) => n.sim),
        );
        const wrong = rows.flatMap((r) => r.got[k].filter((g) => r[k].false_hits.includes(g)).map((g) => Number(g.split(' ')[2] ?? NaN)).filter((s) => !Number.isNaN(s)));
        return [k, { threshold: THRESHOLD[k], lowest_expected_by_meaning: exp.length ? Math.min(...exp) : null, highest_false_hit: wrong.length ? Math.max(...wrong) : null }];
      }),
    );
    const summary = {
      cases: rows.length,
      all_found: Object.fromEntries(KINDS.map((k) => [k, rate(rows.map((r) => r[k].all_found))])),
      cases_with_false_hits: Object.fromEntries(KINDS.map((k) => [k, rows.filter((r) => r[k].false_hits.length).length])),
      clean_cases: rate(rows.map((r) => KINDS.every((k) => r[k].all_found && !r[k].false_hits.length))),
      median_ms: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
      tuning,
    };
    console.log('context', JSON.stringify(summary));
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'context.json'), JSON.stringify({ eval: 'context', model, at: new Date().toISOString(), ...summary, results: rows }, null, 2));
    expect(rows).toHaveLength(cases.length);
  }, 600_000);
});
