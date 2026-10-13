// The conversation read and Who's people (decision 48): `readWho` on fictional selections from
// Discord, Slack, Teams, WhatsApp, email, a contact card, and an article. Scores, per case: whether
// the read's messages were accepted (else the app falls back to the parser), the message authors
// in order, the author of the last message, the people Who lists and the strings it must never
// list, Reply's target (`messagesToAnswer`), and the read's tokens and time. The same cases through
// the parser alone (no model, no calls) give the fallback's numbers.
//
// Calls the model once per case on the Fast role (gpt-oss-20b on today's Groq catalog, decision 60):
//   $env:GLOSSLY_EVAL_LIMIT='18'; pnpm exec vitest run --project evals evals/who.eval.ts
// GLOSSLY_EVAL_MODEL picks another model (the Qwen comparison, decision 60), GLOSSLY_EVAL_IDS a few cases.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  authorFrom,
  DEFAULT_SETTINGS,
  detectPeople,
  messagesToAnswer,
  readWho,
  type DetectInput,
  type LlmProvider,
  type ReadMessage,
  type Settings,
  type WhoRead,
} from '@glossly/core';
import { countedLlm, errorLabel, evalModel, groqKey, limitCases, median, RateLimitStop, budgetCheck, budgetLog, resultsFile, rate, sameName, withRateLimitRetry } from './lib';

interface Case {
  id: string;
  input: DetectInput;
  expected: {
    messages?: string[] | null;
    author?: string;
    people: string[];
    not_people: string[];
    target?: { starts: string; excludes?: string } | null;
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'evals', 'results');
const allCases = (JSON.parse(readFileSync(join(root, 'fixtures', 'who', 'cases.json'), 'utf8')) as { cases: Case[] }).cases;
const cases = limitCases(allCases);
const modelRef = evalModel('groq:openai/gpt-oss-20b');

const identity: Settings['identity'] = { name: 'Alex Morgan', emails: ['alex.morgan@example.com'], handles: ['alexm', 'alexmorgan'] };
const settings = { ...DEFAULT_SETTINGS, identity, privacy: 'all' as const };

/** The app with no model: readWho reads the text only, and Reply falls back to the header parser. */
const noModel: LlmProvider = {
  hasModel: () => false,
  stream: () => {
    throw new Error('no model');
  },
  structured: () => Promise.reject(new Error('no model')),
};

const label = (m: { author: string | null; user: boolean }) => (m.user ? 'me' : (m.author ?? '?'));

/** Authors in order, consecutive messages by one author merged. */
function authors(messages: ReadMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const a = label(m);
    if (!out.length || !(a === out.at(-1) || sameName(a, out.at(-1)))) out.push(a);
  }
  return out;
}

const same = (a: string, b: string) => (a === 'me' || b === 'me' ? a === b : sameName(a, b));

interface Scored {
  read_accepted: boolean | null;
  messages_ok: boolean | null;
  got_messages: string[] | null;
  author_ok: boolean | null;
  got_author: string | null;
  people_found: number;
  people_expected: number;
  got_people: string[];
  bad_people: string[];
  target_ok: boolean | null;
  got_target: string | null;
}

function score(c: Case, read: WhoRead): Scored {
  const e = c.expected;
  const messages = read.messages;
  const got = messages ? authors(messages) : null;
  // As Tasks and Reply do: the read's author, else the parser's (decision 47).
  const by = authorFrom(read, detectPeople(c.input, identity));
  const gotAuthor = by.authorIsMe ? 'me' : (by.author?.name ?? null);
  const names = read.people.map((p) => p.name ?? p.email ?? p.handle ?? '');
  const bad = read.people
    .filter((p) => e.not_people.some((n) => [p.name, p.email, p.handle].some((v) => v && (sameName(v, n) || v.toLowerCase().startsWith(`${n.toLowerCase()}@`)))))
    .map((p) => p.name ?? p.email ?? '');
  // Reply answers nothing when the user wrote the selected message (Capture.startReply).
  const target = by.authorIsMe ? null : messagesToAnswer(c.input.text, c.input.before, identity, messages);
  let targetOk: boolean | null = null;
  if (e.target !== undefined) {
    if (e.target === null) targetOk = target === null;
    else targetOk = Boolean(target && target.text.slice(0, 120).includes(e.target.starts) && !(e.target.excludes && target.text.includes(e.target.excludes)));
  }
  return {
    read_accepted: messages !== null,
    messages_ok: e.messages && got ? got.length === e.messages.length && got.every((a, i) => same(a, e.messages![i]!)) : e.messages ? false : null,
    got_messages: got,
    author_ok: e.author === undefined ? null : gotAuthor !== null && same(gotAuthor, e.author),
    got_author: gotAuthor,
    people_found: e.people.filter((n) => names.some((g) => sameName(g, n))).length,
    people_expected: e.people.length,
    got_people: names,
    bad_people: bad,
    target_ok: targetOk,
    got_target: target ? target.text.slice(0, 60) : null,
  };
}

function summarize(rows: (Scored & { id: string })[]) {
  const scored = (k: 'read_accepted' | 'messages_ok' | 'author_ok' | 'target_ok') => rows.map((r) => r[k]).filter((v): v is boolean => v !== null);
  const expected = rows.reduce((n, r) => n + r.people_expected, 0);
  return {
    cases: rows.length,
    read_accepted: rate(scored('read_accepted')),
    messages: rate(scored('messages_ok')),
    author: rate(scored('author_ok')),
    people_recall: expected ? rows.reduce((n, r) => n + r.people_found, 0) / expected : null,
    cases_with_bad_people: rows.filter((r) => r.bad_people.length).length,
    reply_target: rate(scored('target_ok')),
  };
}

function write(name: string, body: object) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${name}.json`), JSON.stringify(body, null, 2));
}

describe('who eval', () => {
  it('has unique case ids', () => {
    expect(new Set(allCases.map((c) => c.id)).size).toBe(allCases.length);
  });

  it('parser only (the fallback, no calls)', async () => {
    const rows = [];
    for (const c of cases) rows.push({ id: c.id, ...score(c, await readWho(noModel, settings, c.input)) });
    const summary = summarize(rows);
    console.log('parser', JSON.stringify(summary));
    write('who-parser', { eval: 'who', mode: 'parser', at: new Date().toISOString(), ...summary, results: rows });
  });

  it.skipIf(!groqKey())(`read (${modelRef})`, async () => {
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
      let t = performance.now();
      let failure: string | null = null;
      try {
        const read = await withRateLimitRetry(
          // readWho swallows model errors (the app falls back); surface them so a 429 is retried.
          () =>
            readWho(counted.llm, settings, c.input, undefined, (e) => {
              throw e;
            }),
          () => {
            counted.reset();
            t = performance.now();
          },
        );
        const u = counted.calls();
        rows.push({ id: c.id, ...score(c, read), ms: Math.round(performance.now() - t), input_tokens: u.inputTokens, output_tokens: u.outputTokens, error: null });
      } catch (e) {
        if (e instanceof RateLimitStop) {
          stopped = e.message;
          break;
        }
        failure = errorLabel(e);
        const read = await readWho(noModel, settings, c.input);
        rows.push({ id: c.id, ...score(c, { ...read, local: 'model_failed' }), ms: Math.round(performance.now() - t), input_tokens: 0, output_tokens: 0, error: failure });
      }
      const r = rows.at(-1)!;
      console.log(`${c.id.padEnd(12)} read ${r.read_accepted ? 'ok ' : '-- '} msgs ${r.messages_ok ?? '-'} author ${r.author_ok ?? '-'} people ${r.people_found}/${r.people_expected}${r.bad_people.length ? ` BAD ${r.bad_people.join(',')}` : ''} target ${r.target_ok ?? '-'}${r.error ? ` ERR ${r.error}` : ''}`);
    }
    const total = counted.total();
    const summary = {
      ...summarize(rows),
      errors: rows.filter((r) => r.error).length,
      median_ms: median(rows.filter((r) => !r.error).map((r) => r.ms)),
      median_input_tokens: median(rows.filter((r) => !r.error).map((r) => r.input_tokens)),
      median_output_tokens: median(rows.filter((r) => !r.error).map((r) => r.output_tokens)),
      calls: total.attempts,
      input_tokens: total.inputTokens,
      output_tokens: total.outputTokens,
      stopped,
      budget_checks: budgetLog,
    };
    console.log('read', JSON.stringify(summary));
    write(resultsFile(`who-${modelRef.split('/').at(-1)}`).replace(/\.json$/, ''), { eval: 'who', mode: 'read', model: modelRef, at: new Date().toISOString(), ...summary, results: rows });
    // A budget stop keeps the cases run so far; only a rate-limit stop fails the run.
    expect(stopped?.startsWith('budget') ? null : stopped, 'stopped on rate limits').toBeNull();
    expect(summary.errors).toBeLessThanOrEqual(rows.length * 0.1);
  }, 3_600_000);
});
