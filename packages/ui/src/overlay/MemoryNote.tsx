import { useState } from 'react';
import { Bookmark, Undo2 } from 'lucide-react';
import type { AskSaved } from '@glossly/core/api';
import { glossly } from '../bridge';
import { useSecondsLeft } from './SavedToast';

/**
 * One memory Ask saved (decision 78), under the answer with Undo. A memory Ask kept on its own
 * shows its text, since the answer doesn't mention it; a reworded one says so, and Undo puts the
 * old wording back.
 */
export function MemoryNote({ saved }: { saved: AskSaved }) {
  const [undone, setUndone] = useState(false);
  const left = useSecondsLeft(undone ? null : saved.undoUntil);
  const what = saved.asked ? '' : `: ${saved.text}`;
  const label = undone
    ? saved.updated
      ? `Put back the earlier memory in ${saved.collection}.`
      : `Removed from ${saved.collection}.`
    : `${saved.updated ? 'Updated a memory in' : saved.asked ? 'Saved to' : 'Remembered in'} ${saved.collection}${what}`;
  return (
    <div className="inline-note memory-note">
      <Bookmark size={14} strokeWidth={1.75} aria-hidden />
      <span className="memory-text" title={saved.text}>
        {label}
      </span>
      {!undone && left > 0 && (
        <button className="ghost" onClick={() => void glossly.invoke('save:undo', { itemId: saved.itemId }).then((r) => r.undone && setUndone(true))}>
          <Undo2 size={14} strokeWidth={1.75} aria-hidden />
          Undo ({left}s)
        </button>
      )}
    </div>
  );
}
