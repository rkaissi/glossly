// Line icons (lucide-react) plus the Glossly mark. Components only, so Fast Refresh works.
import { Bookmark, ChartColumn, ListChecks, MessageCircle, Reply, UserRoundSearch, type LucideProps } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ActionId } from '@glossly/core/api';

const ICONS: Record<ActionId, ComponentType<LucideProps>> = {
  ask: MessageCircle,
  save: Bookmark,
  reply: Reply,
  who: UserRoundSearch,
  promises: ListChecks,
  visualize: ChartColumn,
};

export function ActionIcon({ action, size = 16 }: { action: ActionId; size?: number }) {
  const Icon = ICONS[action];
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}

/**
 * The Glossly mark (design C1, Oct 10): a text cursor (the selection) with a sparkle (the
 * action). Alternatives Rayan liked are kept in docs/brand/ in case we switch.
 */
export function GlosslyMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 5v14M6 5h6M6 19h6" />
      <path d="M18 3.5Q18 8 22.5 8Q18 8 18 12.5Q18 8 13.5 8Q18 8 18 3.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
