import type { ActionId } from '@glossly/core/api';
import { glossly } from '../bridge';

const ABOUT: Partial<Record<ActionId, { title: string; text: string }>> = {
  reply: { title: 'Reply', text: 'Drafts three replies with what you know about the person, and inserts the one you pick.' },
  who: { title: 'Who is this', text: 'Shows what you have saved about the people in the selection.' },
  promises: { title: 'What did I promise', text: 'Finds commitments in both directions and tracks their due dates.' },
  visualize: { title: 'Visualize', text: 'Turns tables and numbers into a chart you can copy or save.' },
};

/** Later-phase actions that the router can already suggest. */
export function LaterPanel({ action, sessionId, keyboard }: { action: ActionId; sessionId: number; keyboard: boolean }) {
  const about = ABOUT[action] ?? { title: action, text: '' };
  return (
    <div className="panel">
      <h2>{about.title}</h2>
      <p>{about.text}</p>
      <p className="muted">Coming in a later phase. The router suggested it for this selection, and the click was counted.</p>
      <div className="panel-foot">
        <span className="spacer" />
        <button onClick={() => void glossly.invoke('bar:back', { sessionId })}>Back</button>
        {keyboard && (
          <span>
            <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
