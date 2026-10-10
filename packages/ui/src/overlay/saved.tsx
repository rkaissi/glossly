// A saved item as a Recall card or a search result: the snippet with the matched words marked,
// then where it came from and when it was saved.
import type { ReactNode } from 'react';
import type { RecallHit, RecallReason } from '@glossly/core/api';
import { appName, formatDay } from '../dates';

export const REASON_LABELS: Record<RecallReason, string> = {
  same_person: 'Same person',
  same_company: 'Same company',
  same_product: 'Same product',
  same_place: 'Same place',
  similar_topic: 'Similar topic',
  text_match: '',
};

/** Marks every case-insensitive occurrence of `term` in `text`. */
export function Highlighted({ text, term }: { text: string; term: string | null }) {
  const t = term?.trim();
  if (!t) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = t.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, from)) {
    if (i > from) out.push(text.slice(from, i));
    out.push(<mark key={i}>{text.slice(i, i + t.length)}</mark>);
    from = i + t.length;
  }
  out.push(text.slice(from));
  return <>{out}</>;
}

export function SavedRow({
  hit,
  highlight,
  onClick,
  actions,
}: {
  hit: RecallHit;
  highlight?: boolean;
  onClick?: () => void;
  actions?: ReactNode;
}) {
  const meta = [hit.collection, formatDay(hit.created_at), hit.source_app && appName(hit.source_app)].filter(Boolean).join(' · ');
  const reason = REASON_LABELS[hit.reason];
  return (
    <li className={`saved-row${highlight ? ' highlight' : ''}${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <div className="saved-text">
        <Highlighted text={hit.text} term={hit.term} />
      </div>
      {hit.why && <div className="saved-why muted">{hit.why}</div>}
      <div className="saved-meta">
        {reason && <span className="reason">{reason}</span>}
        <span className="muted">{meta}</span>
        {actions && <span className="saved-actions">{actions}</span>}
      </div>
    </li>
  );
}
