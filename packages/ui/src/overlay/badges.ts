import type { Badge } from '@glossly/core/api';
import { firstName } from '../dates';

export interface ShownBadge {
  badge: Badge;
  title: string;
}

const personName = (label: string) => label.split(' · ')[0] ?? label;

/**
 * One person chip on the bar. Several names in a row get clipped at the screen edge,
 * so the bar shows the first person and how many more there are.
 */
export function shownBadges(badges: Badge[]): ShownBadge[] {
  const people = badges.filter((b): b is Extract<Badge, { kind: 'person' }> => b.kind === 'person');
  const rest = badges.filter((b) => b.kind !== 'person');
  const out: ShownBadge[] = [];
  if (people.length === 1) {
    out.push({ badge: people[0]!, title: `Who is ${personName(people[0]!.label)}` });
  } else if (people.length > 1) {
    const names = people.map((p) => personName(p.label));
    const first = firstName(names[0] ?? '');
    const others = people.length - 1;
    const label = first ? `${first} +${others} ${others === 1 ? 'other' : 'others'}` : `${people.length} people`;
    out.push({ badge: { kind: 'person', personId: people[0]!.personId, label }, title: names.join(', ') });
  }
  for (const b of rest) {
    out.push({ badge: b, title: 'What you saved before that relates to this' });
  }
  return out;
}
