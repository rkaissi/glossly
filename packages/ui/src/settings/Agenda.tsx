import { useCallback, useState } from 'react';
import { CalendarDays, ExternalLink, MapPin, Trash2, UsersRound } from 'lucide-react';
import type { CalendarEvent, CommitmentView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { DatePicker } from '../controls/DatePicker';
import { ActionMenu } from '../controls/Menu';
import { Select } from '../controls/Select';
import { Segmented, TaskCheck } from '../controls/Toggles';
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

type RowAction = 'open' | 'delete';

/** The row's "…" menu (Open person, Delete); Delete swaps the row for an inline confirm. */
function RowMenu({ personId, onDelete }: { personId?: string | null; onDelete: () => void }) {
  return (
    <div className="row-acts">
      <ActionMenu<RowAction>
        items={[
          ...(personId ? [{ value: 'open' as const, label: 'Open person', icon: <ExternalLink size={16} strokeWidth={1.75} aria-hidden /> }] : []),
          { value: 'delete', label: 'Delete', danger: true, separator: !!personId, icon: <Trash2 size={16} strokeWidth={1.75} aria-hidden /> },
        ]}
        onPick={(a) => (a === 'open' ? (location.hash = `people/${personId}`) : onDelete())}
      />
    </div>
  );
}

function TaskRow({ t }: { t: CommitmentView }) {
  const [text, setText] = useState(t.text);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const done = t.status !== 'open';
  const saveText = () => {
    const next = text.trim();
    if (!next || next === t.text) return setText(t.text);
    void run(() => glossly.invoke('commitments:update', { id: t.id, text: next }));
  };
  if (confirming)
    return (
      <li className="task confirming">
        <InlineConfirm prompt="Delete this task?" confirm="Delete" busy={busy} onConfirm={() => void run(() => glossly.invoke('commitments:delete', { id: t.id }))} onCancel={() => setConfirming(false)} />
      </li>
    );
  return (
    <li className={`task${done ? ' done' : ''}`}>
      <TaskCheck
        checked={done}
        label={done ? 'Reopen' : 'Mark done'}
        disabled={busy}
        onChange={(on) => void run(() => glossly.invoke('commitments:set-status', { id: t.id, status: on ? 'done' : 'open' }))}
      />
      <div className="grow task-body">
        <input
          className="inline-input"
          value={text}
          maxLength={300}
          aria-label="Task"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={saveText}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="task-sub">{t.person_id ? <a href={`#people/${t.person_id}`}>{owes(t)}</a> : owes(t)}</span>
        {error && <span className="error small block">{error}</span>}
      </div>
      <DatePicker
        variant="chip"
        label="Due date"
        value={t.due_at?.slice(0, 10) ?? null}
        overdue={done ? false : undefined}
        disabled={busy}
        onChange={(day) => void run(() => glossly.invoke('commitments:update', { id: t.id, due_at: day }))}
      />
      <RowMenu personId={t.person_id} onDelete={() => setConfirming(true)} />
    </li>
  );
}

/** Moves a stored start or end to another day, keeping its time and offset. */
const onDay = (stamp: string | null, day: string): string | null => (stamp ? `${day}${stamp.slice(10)}` : null);

function EventRow({ e }: { e: CalendarEvent }) {
  const [title, setTitle] = useState(e.title);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === e.title) return setTitle(e.title);
    void run(() => glossly.invoke('calendar:update', { id: e.id, patch: { title: next } }));
  };
  const moveTo = (day: string | null) => {
    if (!day) return;
    void run(() => glossly.invoke('calendar:update', { id: e.id, patch: { starts_at: onDay(e.starts_at, day)!, ends_at: onDay(e.ends_at, day) } }));
  };
  if (confirming)
    return (
      <li className="task confirming">
        <InlineConfirm prompt="Delete this event?" confirm="Delete" busy={busy} onConfirm={() => void run(() => glossly.invoke('calendar:delete', { id: e.id }))} onCancel={() => setConfirming(false)} />
      </li>
    );
  return (
    <li className="task event">
      <span className="event-icon" aria-hidden>
        <CalendarDays size={16} strokeWidth={1.75} />
      </span>
      <div className="grow task-body">
        <input
          className="inline-input"
          value={title}
          maxLength={200}
          aria-label="Event"
          spellCheck={false}
          onChange={(ev) => setTitle(ev.target.value)}
          onBlur={saveTitle}
          onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
        />
        {(e.location || e.attendees.length > 0) && (
          <span className="task-sub">
            {e.location && (
              <>
                <MapPin size={12} strokeWidth={1.75} aria-hidden /> {e.location}
                {e.attendees.length > 0 && ' · '}
              </>
            )}
            {e.attendees.length > 0 && <>With {e.attendees.join(', ')}</>}
          </span>
        )}
        {error && <span className="error small block">{error}</span>}
      </div>
      <DatePicker variant="chip" label="Move to another day" value={splitStamp(e.starts_at).day} text={formatEventTime(e)} overdue={false} allowNone={false} disabled={busy} onChange={moveTo} />
      <RowMenu onDelete={() => setConfirming(true)} />
    </li>
  );
}

/** A personal todo typed here: the user's own, with no person. */
function AddTodo() {
  const [text, setText] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const add = async () => {
    const r = await run(() => glossly.invoke('commitments:add', { text, due_at: due }));
    if (r !== undefined) {
      setText('');
      setDue(null);
    }
  };
  return (
    <form
      className="row add-todo"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void add();
      }}
    >
      <input className="grow" placeholder="Add a todo" aria-label="New todo" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
      <DatePicker label="Due date for the new todo" value={due} onChange={setDue} noneText="No date" />
      <button type="submit" className="primary" disabled={busy || !text.trim()}>
        Add
      </button>
      {error && <p className="error small">{error}</p>}
    </form>
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
      <div className="row agenda-filters">
        <Segmented label="Show" value={show} onChange={setShow} options={[['all', 'All'], ['tasks', 'Tasks'], ['events', 'Events']]} />
        <Segmented label="When" value={when} onChange={setWhen} options={[['upcoming', 'Upcoming'], ['past', 'Done and past']]} />
        <span className="spacer" />
        <Select
          label="Person"
          value={personId}
          onChange={setPersonId}
          options={[
            { value: '', label: 'Everyone', icon: <UsersRound size={16} strokeWidth={1.75} aria-hidden /> },
            ...(people ?? []).map((p, i) => ({ value: p.id, label: p.name, separator: i === 0 })),
          ]}
        />
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
