// Line icons (lucide-react) plus the Glossly mark. Components only, so Fast Refresh works.
import { Bookmark, ChartColumn, History, ListChecks, MessageCircle, PenLine, Reply, Search, UserRoundSearch, type LucideProps } from 'lucide-react';
import { useId, type ComponentType } from 'react';
import type { ActionId } from '@glossly/core/api';

const ICONS: Record<ActionId, ComponentType<LucideProps>> = {
  ask: MessageCircle,
  save: Bookmark,
  reply: Reply,
  who: UserRoundSearch,
  promises: ListChecks,
  visualize: ChartColumn,
  search: Search,
  recall: History,
  write: PenLine,
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

/** The app icon (Glass, decision 41) as drawn in docs/brand/app-icon-glass.svg; setup's welcome shows it. */
export function GlassIcon({ size = 72 }: { size?: number }) {
  const id = useId();
  return (
    <svg className="glass-icon" width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a6c3e8" />
          <stop offset=".55" stopColor="#c3bbea" />
          <stop offset="1" stopColor="#e3b5ca" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".7" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="92" height="92" rx="22" fill={`url(#${id}g)`} />
      <rect x="4" y="4" width="92" height="92" rx="22" fill={`url(#${id}s)`} />
      <rect x="5" y="5" width="90" height="90" rx="21" fill="none" stroke="#fff" strokeOpacity=".75" />
      <rect x="4.25" y="4.25" width="91.5" height="91.5" rx="21.75" fill="none" stroke="#1f2a44" strokeOpacity=".18" strokeWidth=".5" />
      <g transform="translate(18 18) scale(2.6)">
        <path d="M9 5v14M6 5h6M6 19h6" stroke="#1f2a44" strokeWidth="2" strokeLinecap="round" fill="none" />
        <path d="M18 3.5Q18 8 22.5 8Q18 8 18 12.5Q18 8 13.5 8Q18 8 18 3.5Z" fill="#1f2a44" />
      </g>
    </svg>
  );
}
