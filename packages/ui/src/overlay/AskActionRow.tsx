import { CalendarDays, CircleCheck, Plus, Undo2, User, UserRound } from 'lucide-react';
import type { AskAction } from '@glossly/core/api';
import { glossly } from '../bridge';
import { useSecondsLeft } from './SavedToast';

const ICONS = { task: CircleCheck, event: CalendarDays, person: User, about: UserRound } as const;

const DONE: Record<AskAction['kind'], string> = { task: 'Added to Tasks', event: 'Added to Calendar', person: 'Updated', about: 'Noted about you' };
const OFFER: Record<AskAction['kind'], string> = { task: 'Add to Tasks?', event: 'Add to Calendar?', person: 'Update?', about: 'Note about you?' };
const UNDONE: Record<AskAction['kind'], string> = { task: 'Removed from Tasks', event: 'Removed from Calendar', person: 'Put back', about: 'Removed' };

/**
 * One thing Ask did or offers (decision 78), under the answer: done with Undo, or offered with
 * Add (a task or event Ask only noticed).
 */
export function AskActionRow({ sessionId, action, onChange }: { sessionId: number; action: AskAction; onChange: (a: AskAction) => void }) {
  const left = useSecondsLeft(action.state === 'applied' ? action.undoUntil : null);
  const Icon = ICONS[action.kind];
  const head = action.state === 'applied' ? DONE[action.kind] : action.state === 'offered' ? OFFER[action.kind] : UNDONE[action.kind];
  const accept = () => void glossly.invoke('ask:action-accept', { sessionId, id: action.id }).then((a) => a && onChange(a));
  const undo = () =>
    void glossly.invoke('ask:action-undo', { sessionId, id: action.id }).then((r) => r.undone && onChange({ ...action, state: 'undone', undoUntil: null }));
  return (
    <div className={`inline-note ask-action${action.state === 'offered' ? ' offered' : ''}`}>
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      <span className="memory-text" title={action.label}>
        {head}: {action.label}
      </span>
      {action.state === 'offered' && (
        <button className="ghost" onClick={accept}>
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          Add
        </button>
      )}
      {action.state === 'applied' && left > 0 && (
        <button className="ghost" onClick={undo}>
          <Undo2 size={14} strokeWidth={1.75} aria-hidden />
          Undo ({left}s)
        </button>
      )}
    </div>
  );
}
