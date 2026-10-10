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

/** The Glossly mark: a line of text with a highlight stroke over its middle. */
export function GlosslyMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="5.5" width="13" height="5" rx="2.5" fill="currentColor" opacity="0.22" />
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
