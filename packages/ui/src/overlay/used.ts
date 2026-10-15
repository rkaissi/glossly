import type { ContextUsed } from '@glossly/core/api';

const NAMES: Record<ContextUsed['kind'], [string, string]> = {
  note: ['note', 'notes'],
  person: ['person', 'people'],
  task: ['task', 'tasks'],
  event: ['event', 'events'],
};

/** "Used 2 notes · 1 event": the chip under an answer that drew on saved data (decision 77). */
export function usedSummary(used: Pick<ContextUsed, 'kind'>[]): string {
  const parts = (['note', 'person', 'task', 'event'] as const)
    .map((k) => [k, used.filter((u) => u.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${NAMES[k][n === 1 ? 0 : 1]}`);
  return parts.length ? `Used ${parts.join(' · ')}` : '';
}
