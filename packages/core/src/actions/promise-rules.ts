// What did I promise without a model (Local only with no local model, or no key; decision 34):
// sentence patterns find promises ("I'll send it Friday") and requests ("Can you send me the
// slides?"), and `resolveDue` finds the deadline. Rougher than the model, so rows start
// selected only when they name a deadline; the user still reviews every one.
import { resolveDue } from '../people/dates';
import type { ExtractedCommitments } from './promises';

/** The speaker commits to something: the author promised it. */
const PROMISE = /\b(?:i'll|i will|i'm going to|i am going to|i'm gonna|let me|i promise to|i can)\s+(.+)/i;
/** The speaker asks the reader to do something. */
const REQUEST = /(?:^|\b)(?:(?:can|could|would|will) you|please)\s+(.+)/i;
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
    const req = REQUEST.exec(sentence);
    const prom = req ? null : PROMISE.exec(sentence);
    const m = req ?? prom;
    if (!m) continue;
    const { task, due } = splitDue(m[1]!, now);
    const clean = cleanTask(task);
    if (clean.split(' ').length < 2 || NOT_A_TASK.test(clean)) continue;
    // A promise binds its author; a request binds whoever it was sent to.
    const authorOwes = Boolean(prom);
    const owner = authorOwes === author.isMe ? 'me' : 'them';
    out.push({
      owner,
      person_name: author.isMe ? '' : (author.name ?? ''),
      text: clean,
      due_phrase: due ?? '',
      confidence: due ? 0.6 : 0.4,
    });
  }
  return { commitments: out };
}
