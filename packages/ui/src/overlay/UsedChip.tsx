import { useState } from 'react';
import { CalendarDays, ChevronDown, CircleCheck, FileText, User, X } from 'lucide-react';
import type { ContextUsed } from '@glossly/core/api';
import { glossly } from '../bridge';
import { usedSummary } from './used';

const ICONS = { note: FileText, person: User, task: CircleCheck, event: CalendarDays } as const;

/**
 * "Used 2 notes · 1 event" under an answer (decision 77): what went into the prompt from saved
 * data. Opens into the list; "Not related" leaves a row out of later answers in this session.
 */
export function UsedChip({ sessionId, used }: { sessionId: number; used: ContextUsed[] }) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const shown = used.filter((u) => !gone.has(`${u.kind}:${u.id}`));
  if (used.length === 0) return null;

  const dismiss = (u: ContextUsed) => {
    setGone((g) => new Set(g).add(`${u.kind}:${u.id}`));
    void glossly.invoke('context:dismiss', { sessionId, kind: u.kind, id: u.id });
  };

  return (
    <div className="used">
      <button className="used-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="What this answer drew on from what you saved">
        {usedSummary(used)}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={open ? 'flip' : undefined} />
      </button>
      {open && (
        <ul className="used-list">
          {shown.map((u) => {
            const Icon = ICONS[u.kind];
            return (
              <li key={`${u.kind}:${u.id}`}>
                <Icon size={14} strokeWidth={1.75} aria-hidden />
                <span className="used-label">{u.label}</span>
                {u.detail && <span className="used-detail">{u.detail}</span>}
                <button className="ghost" title="Leave it out of the next answers here" onClick={() => dismiss(u)}>
                  <X size={14} strokeWidth={1.75} aria-hidden />
                  Not related
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="muted">Left out of the next answers here.</li>}
        </ul>
      )}
    </div>
  );
}
