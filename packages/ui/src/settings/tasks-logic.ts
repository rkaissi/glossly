// Pure logic for the Tasks tab (Step 20.2, decision 40): filters, sections, relative day labels,
// and the date words quick add reads. Unit-tested.
import type { CommitmentView } from '@glossly/core/api';
import { addDays, diffDays, fromDay, toDay, weekStart, type Day, type WeekStart } from '../controls/logic';

export type TaskFilter = 'all' | 'me' | 'them' | 'todo';

/** You owe (a promise to someone), They owe, or Todos (yours, with no person). */
export function matchesFilter(t: Pick<CommitmentView, 'owner' | 'person_id'>, f: TaskFilter): boolean {
  if (f === 'all') return true;
  if (f === 'me') return t.owner === 'me' && t.person_id !== null;
  if (f === 'them') return t.owner === 'them';
  return t.person_id === null && t.owner === 'me';
}

export const dueDay = (t: Pick<CommitmentView, 'due_at'>): Day | null => t.due_at?.slice(0, 10) ?? null;

export interface TaskSections {
  overdue: CommitmentView[];
  today: CommitmentView[];
  /** One section per later day, soonest first. */
  days: { day: Day; tasks: CommitmentView[] }[];
  noDate: CommitmentView[];
}

/** Open tasks by when they're due: Overdue (oldest first), Today, each later day, No date. */
export function taskSections(open: CommitmentView[], today: Day): TaskSections {
  const byDue = [...open].sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
  const days = new Map<Day, CommitmentView[]>();
  const out: TaskSections = { overdue: [], today: [], days: [], noDate: [] };
  for (const t of byDue) {
    const d = dueDay(t);
    if (!d) out.noDate.push(t);
    else if (d < today) out.overdue.push(t);
    else if (d === today) out.today.push(t);
    else days.set(d, [...(days.get(d) ?? []), t]);
  }
  out.days = [...days].map(([day, tasks]) => ({ day, tasks }));
  return out;
}

/** "Today", "Tomorrow", "Yesterday", "3 days ago", a weekday within the week ahead, else "Oct 30" (with the year when not this year). */
export function relDay(day: Day, today: Day): string {
  const n = diffDays(day, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < -1 && n > -7) return `${-n} days ago`;
  const d = fromDay(day);
  if (n > 1 && n < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(day.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }) });
}

/** "Done today", "Done yesterday", "Done Oct 2"; just "Done" for tasks finished before completion dates were kept. */
export function doneLabel(completedAt: string | null, today: Day): string {
  if (!completedAt) return 'Done';
  const rel = relDay(toDay(new Date(completedAt)), today);
  return `Done ${/^(Today|Tomorrow|Yesterday)$|days ago$/.test(rel) ? rel.toLowerCase() : rel}`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DATE_WORDS = new RegExp(
  `\\s*\\b(?:(?:by|on|due|before)\\s+)?(today|tonight|tomorrow|next week|(?:this |next )?(?:${WEEKDAYS.join('|')}))\\b`,
  'i',
);

/**
 * The day a quick-add phrase names and where the words are: "tomorrow", "by Friday", "next
 * Monday", "next week" (the next week start). A bare weekday is the next one after today.
 */
export function readDue(text: string, today: Day, ws: WeekStart = 1): { day: Day; index: number; length: number } | null {
  const m = DATE_WORDS.exec(text);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  let day: Day;
  if (w === 'today' || w === 'tonight') day = today;
  else if (w === 'tomorrow') day = addDays(today, 1);
  else if (w === 'next week') day = addDays(weekStart(today, ws), 7);
  else {
    const target = WEEKDAYS.indexOf(w.replace(/^(this|next) /, ''));
    const ahead = (target - fromDay(today).getDay() + 7) % 7 || 7;
    day = addDays(today, ahead);
    // "next Friday" said on Monday is the Friday of next week, not this one.
    if (w.startsWith('next ') && ahead < 7 && addDays(weekStart(today, ws), 7) > day) day = addDays(day, 7);
  }
  return { day, index: m.index, length: m[0].length };
}

/** The title without the date words ("Send Maya the invoice by Friday" is "Send Maya the invoice"). */
export function withoutDue(text: string, found: { index: number; length: number }): string {
  let rest = (text.slice(0, found.index) + text.slice(found.index + found.length)).replace(/\s{2,}/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');
  // "On Monday, file the report" keeps its capital: "File the report".
  if (found.index === 0 && /^[A-Z]/.test(text.trim())) rest = rest.replace(/^./, (c) => c.toUpperCase());
  return rest || text.trim();
}
