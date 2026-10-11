import { useCallback, useState } from 'react';
import { CalendarDays, Check, MapPin, Trash2 } from 'lucide-react';
import type { CalendarEvent, CommitmentView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { formatDue, formatEventTime, splitStamp } from '../dates';
import { groupAgenda } from './agenda-groups';
import { useAction } from './useAction';
import { useLive } from './useLive';

type Show = 'all' | 'tasks' | 'events';
type When = 'upcoming' | 'past';

/** "You owe Jordan", "Jordan owes you", or "Your todo". */
function owes(t: CommitmentView): string {
  if (t.owner === 'them') return t.person_name ? `${t.person_name} owes you` : 'Owed to you';
  return t.person_name ? `You owe ${t.person_name}` : 'Your todo';
}

function Delete({ prompt, busy, onDelete }: { prompt: string; busy: boolean; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <InlineConfirm prompt={prompt} confirm="Delete" busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />
  ) : (
    <button className="icon-btn danger" title="Delete" aria-label={prompt.replace(/\?$/, '')} disabled={busy} onClick={() => setConfirming(true)}>
      <Trash2 size={15} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function TaskRow({ t }: { t: CommitmentView }) {
  const [text, setText] = useState(t.text);
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
        <span className="muted small">{t.person_id ? <a href={`#people/${t.person_id}`}>{owes(t)}</a> : owes(t)}</span>
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
      <Delete prompt="Delete this task?" busy={busy} onDelete={() => void run(() => glossly.invoke('commitments:delete', { id: t.id }))} />
    </li>
  );
}

/** Moves a stored start or end to another day, keeping its time and offset. */
const onDay = (stamp: string | null, day: string): string | null => (stamp ? `${day}${stamp.slice(10)}` : null);

function EventRow({ e }: { e: CalendarEvent }) {
  const [title, setTitle] = useState(e.title);
  const { busy, error, run } = useAction();
  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === e.title) return setTitle(e.title);
    void run(() => glossly.invoke('calendar:update', { id: e.id, patch: { title: next } }));
  };
  const moveTo = (day: string) => {
    if (!day) return;
    void run(() => glossly.invoke('calendar:update', { id: e.id, patch: { starts_at: onDay(e.starts_at, day)!, ends_at: onDay(e.ends_at, day) } }));
  };
  return (
    <li className="task event">
      <span className="event-icon" aria-hidden>
        <CalendarDays size={16} strokeWidth={1.75} />
      </span>
      <div className="grow task-body">
        <input
          className="task-text"
          value={title}
          maxLength={200}
          aria-label="Event"
          spellCheck={false}
          onChange={(ev) => setTitle(ev.target.value)}
          onBlur={saveTitle}
          onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
        />
        <span className="muted small">
          {e.location && (
            <>
              <MapPin size={12} strokeWidth={1.75} aria-hidden /> {e.location}
              {e.attendees.length > 0 && ' · '}
            </>
          )}
          {e.attendees.length > 0 && <>With {e.attendees.join(', ')}</>}
        </span>
        {error && <span className="error small block">{error}</span>}
      </div>
      <label className="due-chip" title="Move to another day">
        <span>{formatEventTime(e)}</span>
        <input type="date" aria-label="Day" value={splitStamp(e.starts_at).day} onChange={(ev) => moveTo(ev.target.value)} />
      </label>
      <Delete prompt="Delete this event?" busy={busy} onDelete={() => void run(() => glossly.invoke('calendar:delete', { id: e.id }))} />
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

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'selected' : undefined} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** "YYYY-MM-DD" for today plus `offset` days, local. */
const dayString = (offset = 0) => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Tasks and events in one place (decisions 36 and 37): upcoming by day (open tasks and the
 * events still ahead), or past (done tasks and events gone by). Filter by kind and person.
 */
export function AgendaTab() {
  const [show, setShow] = useState<Show>('all');
  const [when, setWhen] = useState<When>('upcoming');
  const [personId, setPersonId] = useState('');
  const today = dayString();
  const yesterday = dayString(-1);
  const tasks = useLive(
    useCallback(
      () => glossly.invoke('commitments:list', { status: when === 'upcoming' ? 'open' : 'done', ...(personId && { personId }) }),
      [when, personId],
    ),
  );
  const events = useLive(
    useCallback(
      () => glossly.invoke('calendar:list', { ...(when === 'upcoming' ? { from: today } : { to: yesterday }), ...(personId && { personId }) }),
      [when, personId, today, yesterday],
    ),
  );
  const people = useLive(useCallback(() => glossly.invoke('people:list', { query: '' }), []));
  const shownTasks = show === 'events' ? [] : (tasks ?? []);
  const shownEvents = show === 'tasks' ? [] : (events ?? []);
  const loading = !tasks || !events;

  return (
    <section>
      <h2>Agenda</h2>
      <p className="muted">
        What you owe people, what they owe you, your todos, and your events. Add them from a selection with Tasks and events, or type a todo here. Stored
        on this computer only.
      </p>
      <AddTodo />
      <div className="row">
        <Segmented label="Show" value={show} onChange={setShow} options={[['all', 'All'], ['tasks', 'Tasks'], ['events', 'Events']]} />
        <Segmented label="When" value={when} onChange={setWhen} options={[['upcoming', 'Upcoming'], ['past', 'Done and past']]} />
        <span className="spacer" />
        <select aria-label="Person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">Everyone</option>
          {(people ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : when === 'upcoming' ? (
        <UpcomingList tasks={shownTasks} events={shownEvents} />
      ) : shownTasks.length + shownEvents.length === 0 ? (
        <p className="muted small">Nothing done or past yet.</p>
      ) : (
        <>
          {shownEvents.length > 0 && (
            <div className="agenda-group">
              <h3>Past events</h3>
              <ul className="list tasks">
                {[...shownEvents].reverse().map((e) => (
                  <EventRow key={`${e.id}:${e.title}:${e.starts_at}`} e={e} />
                ))}
              </ul>
            </div>
          )}
          {shownTasks.length > 0 && (
            <div className="agenda-group">
              <h3>Done</h3>
              <ul className="list tasks">
                {shownTasks.map((t) => (
                  <TaskRow key={`${t.id}:${t.text}`} t={t} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function UpcomingList({ tasks, events }: { tasks: CommitmentView[]; events: CalendarEvent[] }) {
  const groups = groupAgenda(tasks, events);
  if (groups.length === 0) return <p className="muted small">Nothing coming up.</p>;
  return (
    <>
      {groups.map((g) => (
        <div key={g.label} className="agenda-group">
          <h3 className={g.label === 'Overdue' ? 'error' : undefined}>{g.label}</h3>
          <ul className="list tasks">
            {g.entries.map((entry) =>
              entry.kind === 'task' ? (
                <TaskRow key={`${entry.task.id}:${entry.task.text}`} t={entry.task} />
              ) : (
                <EventRow key={`${entry.event.id}:${entry.event.title}:${entry.event.starts_at}`} e={entry.event} />
              ),
            )}
          </ul>
        </div>
      ))}
    </>
  );
}
