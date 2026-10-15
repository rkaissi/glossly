// The days a text names ("are you free Thursday?", "this weekend", "Oct 16"), so the retriever
// can bring that day's events and tasks whatever their words (decision 77). Each phrase is
// resolved by `resolveDue`, the same reader Tasks uses for due dates.
import { resolveDue } from '../people/dates';

const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|weds|thurs)';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const PHRASE = new RegExp(
  [
    '\\b(?:today|tonight|tomorrow|tmrw|yesterday)\\b',
    `\\b(?:next |this |on )?${WEEKDAY}\\b`,
    `\\b${MONTH} \\d{1,2}(?:st|nd|rd|th)?\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH}(?=\\s|$|[.,!?])`,
    '\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b',
    '\\bthe \\d{1,2}(?:st|nd|rd|th)\\b',
    '\\b(?:this |next |the )?weekend\\b',
  ].join('|'),
  'g',
);

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Saturday and Sunday of "this weekend" (the coming one, or the current one on a weekend) or "next weekend". */
function weekend(phrase: string, now: Date): string[] {
  const day = now.getDay();
  const toSat = day === 0 ? -1 : 6 - day;
  const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toSat + (phrase.startsWith('next') ? 7 : 0));
  const sun = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + 1);
  return [iso(sat), iso(sun)];
}

/** Every day the text names, as "YYYY-MM-DD", in the order they appear, at most `max`. */
export function namedDays(text: string, now: Date = new Date(), max = 4): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  for (const m of lower.matchAll(PHRASE)) {
    const phrase = m[0].replace(/^on /, '');
    const days = phrase.endsWith('weekend')
      ? weekend(phrase, now)
      : [resolveDue(phrase === 'tmrw' ? 'tomorrow' : phrase === 'tonight' ? 'today' : phrase, now)?.slice(0, 10)];
    for (const d of days) if (d && !out.includes(d)) out.push(d);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
