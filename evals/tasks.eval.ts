// Tasks and events (decisions 36, 37, 48): `extractPromises` on fictional messages, with the open
// tasks saved before each one, on a fixed day (Wednesday, Oct 14 2026). Multi-writer selections get
// a perfect conversation read (`messages` in the fixture), so this scores the extraction alone; the
// read has its own eval (who.eval.ts). Scores: tasks found (owner and words), the person, the due
// date (the model copies the phrase, `resolveDue` reads it: this is the date resolver's
// model-in-the-loop eval), the change against an open task (new, same, done, moved), events found
// with their day and time, extra rows, tokens, and time.
//
// Calls the model once per case on the Fast role (gpt-oss-20b on today's Groq catalog, decision 60):
//   $env:GLOSSLY_EVAL_LIMIT='18'; pnpm exec vitest run --project evals evals/tasks.eval.ts
// GLOSSLY_EVAL_MODEL picks another model (the Qwen comparison, decision 60), GLOSSLY_EVAL_IDS a few cases.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  acceptMessages,
  DEFAULT_SETTINGS,
  extractPromises,
  PeopleRepo,
  Store,
  type DetectedPerson,
  type PromisesExtract,
  type SelectionPayload,
  type Settings,
} from '@glossly/core';
import { countedLlm, errorLabel, evalModel, groqKey, limitCases, median, RateLimitStop, budgetCheck, budgetLog, resultsFile, rate, sameName, withRateLimitRetry } from './lib';

interface ExpectedTask {
  owner: 'me' | 'them';
  has: string[];
  person?: string | null;
  due?: string | null;
  change?: 'new' | 'same' | 'done' | 'moved';
  open?: number;
}
interface ExpectedEvent {
  has: string[];
  day: string;
  start: string | null;
}
interface Case {
  id: string;
  selection: { text: string; context_before?: string; source_app: string; window_title: string };
  author: string | 'me' | null;
  messages?: { author: string; user: boolean; starts: string }[];
  people?: string[];
  open?: { owner: 'me' | 'them'; person: string | null; text: string; due: string | null }[];
  expected: { tasks: ExpectedTask[]; events: ExpectedEvent[] | null };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'evals', 'results');
const allCases = (JSON.parse(readFileSync(join(root, 'fixtures', 'tasks', 'cases.json'), 'utf8')) as { cases: Case[] }).cases;
const cases = limitCases(allCases);
const modelRef = evalModel('groq:openai/gpt-oss-20b');

const identity: Settings['identity'] = { name: 'Alex Morgan', emails: ['alex.morgan@example.com'], handles: ['alexm'] };
const settings = { ...DEFAULT_SETTINGS, identity, privacy: 'all' as const };
// Wednesday, Oct 14 2026, 10:00 local time.
const now = new Date(2026, 9, 14, 10, 0);

const person = (name: string, role: DetectedPerson['role']): DetectedPerson => ({ name, email: null, handle: null, role, knownId: null });

/** A fresh in-memory store with the case's open tasks, and the input the app would build. */
function setup(c: Case) {
  const store = new Store(':memory:');
  const people = new PeopleRepo(store);
  const ids = new Map<string, string>();
  const idOf = (name: string) => ids.get(name) ?? ids.set(name, people.create({ name }).id).get(name)!;
  const openIds = (c.open ?? []).map((t) => people.addCommitment({ person_id: t.person ? idOf(t.person) : null, owner: t.owner, text: t.text, due_at: t.due }).id);
  const selection: SelectionPayload = {
    text: c.selection.text,
    context_before: c.selection.context_before ?? '',
    context_after: '',
    source_app: c.selection.source_app,
    window_title: c.selection.window_title,
    captured_at: now.toISOString(),
    method: 'uia',
    trigger: 'auto',
    is_editable: false,
    foreground_handle: 1,
  };
  const messages = c.messages
    ? acceptMessages(c.messages, { text: selection.text, before: selection.context_before, after: '', source_app: selection.source_app, window_title: selection.window_title }, identity)
    : null;
  const input = {
    selection,
    author: c.author && c.author !== 'me' ? person(c.author, 'author') : null,
    authorIsMe: c.author === 'me',
    people: (c.people ?? []).map((n) => person(n, 'mentioned')),
    messages,
  };
  return { store, people, input, openIds };
}

interface Scored {
  tasks_found: number;
  tasks_expected: number;
  checks: { person: boolean[]; due: boolean[]; change: boolean[] };
  events_found: number;
  events_expected: number;
  event_times: boolean[];
  extra_tasks: string[];
  extra_events: string[];
  misses: string[];
}

const has = (text: string, words: string[]) => words.every((w) => text.toLowerCase().includes(w.toLowerCase()));

function score(c: Case, out: PromisesExtract, openIds: string[]): Scored {
  const s: Scored = { tasks_found: 0, tasks_expected: c.expected.tasks.length, checks: { person: [], due: [], change: [] }, events_found: 0, events_expected: c.expected.events?.length ?? 0, event_times: [], extra_tasks: [], extra_events: [], misses: [] };
  // Rows the app lists: new ones and changes to open tasks (a "same" row shows as Already open).
  const rows = [...out.rows];
  for (const e of c.expected.tasks) {
    const i = rows.findIndex((r) => r.owner === e.owner && has(r.existing?.text ? `${r.text} ${r.existing.text}` : r.text, e.has));
    if (i < 0) {
      s.misses.push(`task ${e.owner}: ${e.has.join(' ')}`);
      continue;
    }
    const r = rows.splice(i, 1)[0]!;
    s.tasks_found++;
    if (e.person !== undefined) {
      const ok = e.person === null ? !r.person_name : sameName(r.person_name, e.person) || sameName(r.match?.name, e.person) || sameName(r.existing?.person_name, e.person);
      s.checks.person.push(ok);
      if (!ok) s.misses.push(`${e.has.join(' ')}: person ${r.person_name ?? 'none'}`);
    }
    if (e.due !== undefined) {
      const ok = (r.due_at?.slice(0, 10) ?? null) === e.due;
      s.checks.due.push(ok);
      if (!ok) s.misses.push(`${e.has.join(' ')}: due ${r.due_at ?? 'none'} from "${r.due_phrase ?? ''}"`);
    }
    if (e.change !== undefined) {
      const ok = r.change === e.change && (e.open === undefined || r.existing?.id === openIds[e.open]);
      s.checks.change.push(ok);
      if (!ok) s.misses.push(`${e.has.join(' ')}: change ${r.change}${r.existing ? ' (an open task)' : ''}`);
    }
  }
  s.extra_tasks = rows.map((r) => `${r.owner}: ${r.text}`);
  if (c.expected.events) {
    const events = [...out.events];
    for (const e of c.expected.events) {
      const i = events.findIndex((ev) => has(ev.title, e.has));
      if (i < 0) {
        s.misses.push(`event: ${e.has.join(' ')}`);
        continue;
      }
      const ev = events.splice(i, 1)[0]!;
      s.events_found++;
      const day = ev.starts_at?.slice(0, 10) ?? null;
      const start = ev.all_day ? null : (ev.starts_at?.slice(11, 16) ?? null);
      const ok = day === e.day && start === e.start;
      s.event_times.push(ok);
      if (!ok) s.misses.push(`event ${e.has.join(' ')}: ${ev.starts_at ?? 'no day'}${ev.all_day ? ' all day' : ''} from "${ev.when_phrase ?? ''}"`);
    }
    s.extra_events = events.map((ev) => ev.title);
  }
  return s;
}

function summarize(rows: (Scored & { id: string })[]) {
  const sum = (f: (r: Scored) => number) => rows.reduce((n, r) => n + f(r), 0);
  const all = (k: keyof Scored['checks']) => rows.flatMap((r) => r.checks[k]);
  return {
    cases: rows.length,
    task_recall: sum((r) => r.tasks_expected) ? sum((r) => r.tasks_found) / sum((r) => r.tasks_expected) : null,
    person: rate(all('person')),
    due_dates: rate(all('due')),
    due_dates_scored: all('due').length,
    changes: rate(all('change')),
    event_recall: sum((r) => r.events_expected) ? sum((r) => r.events_found) / sum((r) => r.events_expected) : null,
    event_day_and_time: rate(rows.flatMap((r) => r.event_times)),
    extra_tasks: sum((r) => r.extra_tasks.length),
    extra_events: sum((r) => r.extra_events.length),
    cases_all_right: rows.filter((r) => !r.misses.length && !r.extra_tasks.length && !r.extra_events.length).length,
  };
}

describe('tasks eval', () => {
  it('has unique case ids', () => {
    expect(new Set(allCases.map((c) => c.id)).size).toBe(allCases.length);
  });

  it('scores a scripted right answer as all right (no calls)', async () => {
    // Open tasks reach the model as t1, t2... ordered by due date.
    const answers: Record<string, unknown> = {
      'open-01': {
        commitments: [
          { owner: 'user', person_name: 'Jordan Hale', text: 'Send the budget', due_phrase: '', confidence: 0.9, change: 'done', open_task: 't2' },
          { owner: 'user', person_name: 'Jordan Hale', text: 'Review the venue proposal', due_phrase: 'Monday', confidence: 0.9, change: 'moved', open_task: 't1' },
        ],
        events: [],
      },
      'event-01': {
        commitments: [{ owner: 'user', person_name: 'Jordan Hale', text: 'Bring the deck', due_phrase: '', confidence: 0.9, change: 'new', open_task: 'none' }],
        events: [{ title: 'Lunch with Jordan', when: 'Thursday at 1pm', end: '', duration_minutes: 0, location: 'Northwind Cafe', people: ['Jordan Hale'], confidence: 0.9 }],
      },
    };
    for (const [id, answer] of Object.entries(answers)) {
      const c = allCases.find((x) => x.id === id)!;
      const { store, people, input, openIds } = setup(c);
      const fake = { hasModel: () => true, stream: () => { throw new Error('unused'); }, structured: async () => answer } as never;
      const s = score(c, await extractPromises(fake, people, settings, input, undefined, now), openIds);
      store.close();
      expect(s.misses, id).toEqual([]);
      expect(s.tasks_found, id).toBe(s.tasks_expected);
      expect(s.events_found, id).toBe(s.events_expected);
    }
  });

  it.skipIf(!groqKey())(`tasks and events (${modelRef})`, async () => {
    const counted = countedLlm(modelRef);
    const rows = [];
    let stopped: string | null = null;
    for (const [i, c] of cases.entries()) {
      // Every few cases: is what's left of the day enough for the rest (Rayan)? If not, stop here.
      const cut = budgetCheck(counted, i, cases.length - i, 1);
      if (cut) {
        stopped = cut;
        break;
      }
      const { store, people, input, openIds } = setup(c);
      let t = performance.now();
      try {
        const out = await withRateLimitRetry(
          () => extractPromises(counted.llm, people, settings, input, undefined, now),
          () => {
            counted.reset();
            t = performance.now();
          },
        );
        const u = counted.calls();
        rows.push({ id: c.id, ...score(c, out, openIds), ms: Math.round(performance.now() - t), input_tokens: u.inputTokens, output_tokens: u.outputTokens, error: null as string | null });
      } catch (e) {
        if (e instanceof RateLimitStop) {
          stopped = e.message;
          store.close();
          break;
        }
        rows.push({ id: c.id, ...score(c, { rows: [], events: [], sameDay: [], open: [], byRules: null }, openIds), ms: Math.round(performance.now() - t), input_tokens: 0, output_tokens: 0, error: errorLabel(e) });
      }
      store.close();
      const r = rows.at(-1)!;
      console.log(`${c.id.padEnd(9)} tasks ${r.tasks_found}/${r.tasks_expected} events ${r.events_found}/${r.events_expected} extra ${r.extra_tasks.length + r.extra_events.length}${r.misses.length ? ` | ${r.misses.join('; ')}` : ''}${r.error ? ` ERR ${r.error}` : ''}`);
    }
    const total = counted.total();
    const ok = rows.filter((r) => !r.error);
    const summary = {
      ...summarize(rows),
      errors: rows.length - ok.length,
      median_ms: median(ok.map((r) => r.ms)),
      median_input_tokens: median(ok.map((r) => r.input_tokens)),
      median_output_tokens: median(ok.map((r) => r.output_tokens)),
      calls: total.attempts,
      input_tokens: total.inputTokens,
      output_tokens: total.outputTokens,
      stopped,
      budget_checks: budgetLog,
    };
    console.log('tasks', JSON.stringify(summary));
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, resultsFile(`tasks-${modelRef.split('/').at(-1)}`)), JSON.stringify({ eval: 'tasks', model: modelRef, at: new Date().toISOString(), ...summary, results: rows }, null, 2));
    // A budget stop keeps the cases run so far; only a rate-limit stop fails the run.
    expect(stopped?.startsWith('budget') ? null : stopped, 'stopped on rate limits').toBeNull();
    expect(summary.errors).toBeLessThanOrEqual(rows.length * 0.1);
  }, 3_600_000);
});
