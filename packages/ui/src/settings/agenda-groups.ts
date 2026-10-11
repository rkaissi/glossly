// The Agenda tab's grouping (decision 37): open tasks and upcoming events by day. Pure, unit-tested.
import type { CalendarEvent, CommitmentView } from '@glossly/core/api';

export type AgendaEntry = { kind: 'task'; task: CommitmentView; at: string | null } | { kind: 'event'; event: CalendarEvent; at: string };

export interface AgendaGroup {
  label: 'Overdue' | 'Today' | 'Tomorrow' | 'This week' | 'Later' | 'No date';
  entries: AgendaEntry[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayString = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Tasks by due date and events by start, in groups: Overdue (tasks only; a past event just
 * passed), Today, Tomorrow, This week (the next 7 days), Later, and No date. Within a day,
 * all-day events and dateless times come first, then by time.
 */
export function groupAgenda(tasks: CommitmentView[], events: CalendarEvent[], now = new Date()): AgendaGroup[] {
  const today = dayString(now);
  const tomorrow = dayString(plusDays(now, 1));
  const weekEnd = dayString(plusDays(now, 7));
  const entries: AgendaEntry[] = [
    ...tasks.map((task): AgendaEntry => ({ kind: 'task', task, at: task.due_at })),
    ...events.filter((e) => e.starts_at.slice(0, 10) >= today).map((event): AgendaEntry => ({ kind: 'event', event, at: event.starts_at })),
  ];
  const label = (at: string | null): AgendaGroup['label'] => {
    if (!at) return 'No date';
    const day = at.slice(0, 10);
    if (day < today) return 'Overdue';
    if (day === today) return 'Today';
    if (day === tomorrow) return 'Tomorrow';
    if (day <= weekEnd) return 'This week';
    return 'Later';
  };
  // A day alone sorts before any time on it ("2026-10-15" < "2026-10-15T09:00").
  const sorted = [...entries].sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  const order: AgendaGroup['label'][] = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'];
  return order.map((l) => ({ label: l, entries: sorted.filter((e) => label(e.at) === l) })).filter((g) => g.entries.length > 0);
}
