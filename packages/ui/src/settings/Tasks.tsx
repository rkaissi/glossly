import { useCallback, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import type { CommitmentStatus, CommitmentView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { formatDue } from '../dates';
import { useAction } from './useAction';
import { useLive } from './useLive';

/** "You owe Jordan", "Jordan owes you", or "Your todo". */
function owes(t: CommitmentView): string {
  if (t.owner === 'them') return t.person_name ? `${t.person_name} owes you` : 'Owed to you';
  return t.person_name ? `You owe ${t.person_name}` : 'Your todo';
}

function TaskRow({ t }: { t: CommitmentView }) {
  const [text, setText] = useState(t.text);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const due = formatDue(t.due_at);
  const done = t.status !== 'open';
  const saveText = () => {
    const next = text.trim();
    if (!next || next === t.text) return setText(t.text);
    void run(() => glossly.invoke('commitments:update', { id: t.id, text: next }));
  };
  return (
    <li className={`task${done ? ' done' : ''}`}>
      <button
        className={`check${done ? ' on' : ''}`}
        role="checkbox"
        aria-checked={done}
        aria-label={done ? 'Reopen' : 'Mark done'}
        title={done ? 'Reopen' : 'Mark done'}
        disabled={busy}
        onClick={() => void run(() => glossly.invoke('commitments:set-status', { id: t.id, status: done ? 'open' : 'done' }))}
      >
        {done && <Check size={12} strokeWidth={2.5} aria-hidden />}
      </button>
      <div className="grow task-body">
        <input
          className="task-text"
          value={text}
          maxLength={300}
          aria-label="Task"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={saveText}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="muted small">
          {t.person_id ? <a href={`#people/${t.person_id}`}>{owes(t)}</a> : owes(t)}
        </span>
        {error && <span className="error small block">{error}</span>}
      </div>
      <label className={`due-chip${due.overdue && !done ? ' overdue' : ''}`}>
        <span>{t.due_at ? due.label : 'No date'}</span>
        <input
          type="date"
          aria-label="Due date"
          value={t.due_at?.slice(0, 10) ?? ''}
          onChange={(e) => void run(() => glossly.invoke('commitments:update', { id: t.id, due_at: e.target.value || null }))}
        />
      </label>
      {confirming ? (
        <InlineConfirm
          prompt="Delete this task?"
          confirm="Delete"
          busy={busy}
          onConfirm={() => void run(() => glossly.invoke('commitments:delete', { id: t.id }))}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button className="icon-btn danger" title="Delete" aria-label="Delete task" disabled={busy} onClick={() => setConfirming(true)}>
          <Trash2 size={15} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </li>
  );
}

/** A personal todo typed here: the user's own, with no person. */
function AddTodo() {
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const { busy, error, run } = useAction();
  const add = async () => {
    const r = await run(() => glossly.invoke('commitments:add', { text, due_at: due || null }));
    if (r !== undefined) {
      setText('');
      setDue('');
    }
  };
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void add();
      }}
    >
      <input className="grow" placeholder="Add a todo" aria-label="New todo" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
      <input type="date" aria-label="Due date for the new todo" value={due} onChange={(e) => setDue(e.target.value)} />
      <button type="submit" disabled={busy || !text.trim()}>
        Add
      </button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** Every task: promises, requests, and todos (decision 36), open or done, filtered by person. */
export function TasksTab() {
  const [status, setStatus] = useState<CommitmentStatus>('open');
  const [personId, setPersonId] = useState('');
  const tasks = useLive(useCallback(() => glossly.invoke('commitments:list', { status, ...(personId && { personId }) }), [status, personId]));
  const people = useLive(useCallback(() => glossly.invoke('people:list', { query: '' }), []));
  const withTasks = (people ?? []).filter((p) => p.open > 0 || p.id === personId);
  return (
    <section>
      <h2>Tasks</h2>
      <p className="muted">What you owe people, what they owe you, and your own todos. Add them from a selection with Tasks, or type one here.</p>
      <AddTodo />
      <div className="row">
        <div className="segmented" role="radiogroup" aria-label="Show">
          {(['open', 'done'] as const).map((s) => (
            <button key={s} role="radio" aria-checked={status === s} className={status === s ? 'selected' : undefined} onClick={() => setStatus(s)}>
              {s === 'open' ? 'Open' : 'Done'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <select aria-label="Person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">Everyone</option>
          {withTasks.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {tasks && tasks.length > 0 ? (
        <ul className="list tasks">
          {tasks.map((t) => (
            <TaskRow key={`${t.id}:${t.text}`} t={t} />
          ))}
        </ul>
      ) : (
        <p className="muted small">{!tasks ? 'Loading…' : status === 'open' ? 'Nothing open.' : 'Nothing done yet.'}</p>
      )}
    </section>
  );
}
