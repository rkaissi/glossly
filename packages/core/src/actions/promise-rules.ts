// Tasks without a model (Local only with no local model, or no key; decision 34):
// sentence patterns find promises ("I'll send it Friday") and requests ("Can you send me the
// slides?"), and `resolveDue` finds the deadline. Rougher than the model, so rows start
// selected only when they name a deadline; the user still reviews every one.
import { resolveDue } from '../people/dates';
import { isEventSentence } from '../calendar/events';
import { canonicalize } from '../people/names';
import type { ExtractedCommitments, OpenTaskRef } from './promises';

/** The speaker commits to something, or notes something they have to do: it binds the author. */
const PROMISE = /\b(?:i'll|i will|i'm going to|i am going to|i'm gonna|let me|i promise to|i can|i need to|i have to|i must)\s+(.+)/i;
/** The speaker asks the reader to do something, or reminds them. */
const REQUEST = /(?:^|\b)(?:(?:can|could|would|will) you|please|remember to|don't forget to|do not forget to)\s+(.+)/i;
/** A todo line: "todo: book flights", "- [ ] renew passport by Nov 1". */
const TODO = /^(?:to-?do:?|\[ \]|- \[ \])\s*(.+)/i;
/** Not commitments: "can you believe it", "I'll be honest", "let me know". */
const NOT_A_TASK = /^(?:believe|imagine|see|tell|be honest|be there|be fine|be okay|be ok|know|think|guess|bet|try)\b/i;
const MAX_WORDS = 12;

/** Words that can start a deadline phrase ("by Friday", "next week", "tomorrow 3pm", "10/14"). */
const DUE_START =
  /\b(?:by|before|on|until|till|due|this|next|end of|eod|eow|today|tonight|tomorrow|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2})\b/gi;

/** The task without its deadline, and the deadline as written (null when none resolves). */
export function splitDue(clause: string, now: Date): { task: string; due: string | null } {
  for (const m of clause.matchAll(DUE_START)) {
    const tail = clause.slice(m.index).split(/\s+/);
    // The longest run of up to 5 words from here that resolves to a date.
    for (let n = Math.min(5, tail.length); n >= 1; n--) {
      const phrase = tail.slice(0, n).join(' ').replace(/[.,;:!?)]+$/, '');
      if (resolveDue(phrase, now)) {
        const rest = tail.slice(n).join(' ');
        return { task: `${clause.slice(0, m.index)} ${rest}`.replace(/\s+/g, ' ').trim(), due: phrase };
      }
    }
  }
  return { task: clause, due: null };
}

function cleanTask(s: string): string {
  const words = s
    .replace(/^(?:please|also|just|then)\s+/i, '')
    .replace(/\s+(?:please|pls|thanks|thank you)\b.*$/i, '')
    .replace(/[\s.,;:!?)-]+$/, '')
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, MAX_WORDS).join(' ');
}

/**
 * Commitments found by patterns, in the model's output shape so `toPromiseRows` treats both
 * alike. `author` is who wrote the message (null when unknown); a promise is theirs to keep, a
 * request is the reader's.
 */
export function rulesCommitments(text: string, author: { name: string | null; isMe: boolean }, now: Date = new Date()): ExtractedCommitments {
  const out: ExtractedCommitments['commitments'] = [];
  const sentences = text
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    // "Can you make lunch Thursday at 1?" is an event, found by `rulesEvents`, not a task.
    if (isEventSentence(sentence)) continue;
    const todo = TODO.exec(sentence);
    const req = todo ? null : REQUEST.exec(sentence);
    const prom = todo || req ? null : PROMISE.exec(sentence);
    const m = todo ?? req ?? prom;
    if (!m) continue;
    const { task, due } = splitDue(m[1]!, now);
    const clean = cleanTask(task);
    if (clean.split(' ').length < 2 || NOT_A_TASK.test(clean)) continue;
    // A promise binds its author; a request binds whoever it was sent to; a todo line is the user's own.
    const authorOwes = Boolean(prom);
    const owner = todo ? 'me' : authorOwes === author.isMe ? 'me' : 'them';
    out.push({
      owner,
      person_name: todo || author.isMe ? '' : (author.name ?? ''),
      text: clean,
      due_phrase: due ?? '',
      confidence: due ? 0.6 : 0.4,
    });
  }
  return { commitments: out };
}

const words = (s: string) => new Set(canonicalize(s).split(' ').filter((w) => w.length >= 3));

/** Share of the smaller word set found in the other (0 to 1). */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

/**
 * Without a model, a pattern row that says nearly the same as an open task with the same owner
 * is that task (decision 36): "same", or "moved" when it names a different deadline. Finished
 * tasks aren't detected by patterns; the open list beside the rows has Done for those.
 */
export function matchOpenTasks(out: ExtractedCommitments, open: OpenTaskRef[], minOverlap = 0.6): ExtractedCommitments {
  const used = new Set<string>();
  return {
    commitments: out.commitments.map((c) => {
      const hit = open
        .filter((o) => !used.has(o.key) && o.task.owner === c.owner)
        .map((o) => ({ o, score: overlap(c.text, o.task.text) }))
        .filter((h) => h.score >= minOverlap)
        .sort((a, b) => b.score - a.score)[0];
      if (!hit) return { ...c, change: 'new' as const, open_task: 'none' };
      used.add(hit.o.key);
      return { ...c, change: c.due_phrase ? ('moved' as const) : ('same' as const), open_task: hit.o.key };
    }),
  };
}
