import { type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink, Plus, Trash2, UsersRound } from 'lucide-react';
import type { CommitmentView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { DatePicker } from '../controls/DatePicker';
import { toDay } from '../controls/logic';
import { ActionMenu } from '../controls/Menu';
import { Select } from '../controls/Select';
import { TaskCheck } from '../controls/Toggles';
import { WeekStartContext } from '../controls/week';
import { doneLabel, dueDay, matchesFilter, readDue, relDay, taskSections, withoutDue, type TaskFilter } from './tasks-logic';
import { useAction } from './useAction';
import { useLive } from './useLive';
import './tasks.css';

const FILTERS: [TaskFilter, string][] = [
  ['all', 'All'],
  ['me', 'You owe'],
  ['them', 'They owe'],
  ['todo', 'Todos'],
];

/** "For Jordan Hale" (you owe them) or "Waiting on Maya Chen" (they owe you), linking to the person. */
function WhoLine({ t }: { t: CommitmentView }) {
  if (!t.person_id) return null;
  const them = t.owner === 'them';
  return (
    <a className="task-who" href={`#people/${t.person_id}`}>
      {them ? <ArrowDownLeft size={12} strokeWidth={1.75} aria-hidden /> : <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden />}
      {them ? 'Waiting on' : 'For'} {t.person_name ?? 'someone'}
    </a>
  );
}

function TaskRow({ t, today, showDue, fresh, onDone }: { t: CommitmentView; today: string; showDue: boolean; fresh: boolean; onDone: (t: CommitmentView, done: boolean) => void }) {
  const [text, setText] = useState(t.text);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { busy, error, run } = useAction();
  const done = t.status !== 'open';
  const due = dueDay(t);
  const setDue = (day: string | null) => void run(() => glossly.invoke('commitments:update', { id: t.id, due_at: day }));
  const saveText = () => {
    const next = text.trim();
    if (!next || next === t.text) return setText(t.text);
    void run(() => glossly.invoke('commitments:update', { id: t.id, text: next }));
  };

  return (
    <li className={`task-row${done ? ' done' : ''}${leaving ? ' leaving' : ''}${fresh ? ' fresh' : ''}`}>
      <TaskCheck
        checked={done || leaving}
        label={done ? 'Reopen' : 'Mark done'}
        disabled={busy || leaving}
        onChange={(on) => {
          // The check pops while the row slides out, then the list moves it (Completed or back).
          setLeaving(true);
          setTimeout(() => onDone(t, on), 420);
        }}
      />
      <div className="task-title">
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
        <WhoLine t={t} />
        {error && <span className="error small">{error}</span>}
      </div>
      {done ? (
        <span className="task-when">{doneLabel(t.completed_at, today)}</span>
      ) : (
        showDue && due && <DatePicker variant="chip" label="Due date" value={due} text={relDay(due, today)} onChange={setDue} disabled={busy} />
      )}
      <div className="row-acts">
        {!done && <DatePicker variant="icon" label={due ? 'Change date' : 'Add date'} value={due} onChange={setDue} disabled={busy} />}
        {/* Menu pick arms delete in place (decision 46's morph); blur or Esc backs out. */}
        {confirming ? (
          <button
            type="button"
            className="delete-btn armed"
            title="Delete this task"
            aria-label="Confirm: delete this task"
            disabled={busy}
            autoFocus
            onClick={() => void run(() => glossly.invoke('commitments:delete', { id: t.id }))}
            onBlur={() => setConfirming(false)}
            onKeyDown={(e) => e.key === 'Escape' && setConfirming(false)}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            <span>Delete</span>
          </button>
        ) : (
          <ActionMenu<'open' | 'delete'>
            items={[
              ...(t.person_id ? [{ value: 'open' as const, label: `Open ${(t.person_name ?? 'person').split(' ')[0]}`, icon: <ExternalLink size={16} strokeWidth={1.75} aria-hidden /> }] : []),
              { value: 'delete', label: 'Delete', danger: true, separator: !!t.person_id, icon: <Trash2 size={16} strokeWidth={1.75} aria-hidden /> },
            ]}
            onPick={(a) => (a === 'open' ? (location.hash = `people/${t.person_id}`) : setConfirming(true))}
          />
        )}
      </div>
    </li>
  );
}

function Section({ title, count, when, tone, children }: { title: string; count: number; when?: string; tone?: 'overdue'; children: ReactNode }) {
  return (
    <div className="task-section">
      <h3 className={`task-section-head${tone ? ` ${tone}` : ''}`}>
        {title}
        <span className="n">{count}</span>
        {when && <span className="when">{when}</span>}
      </h3>
      <ul className="task-list">{children}</ul>
    </div>
  );
}

/** Text first, then the due chip; a date said in the text fills the chip and leaves the title (decision 40). */
/** `person`: the person filter's pick; a new task is then owed to them. */
function QuickAdd({ today, person }: { today: string; person: { id: string; name: string } | null }) {
  const ws = useContext(WeekStartContext);
  const [text, setText] = useState('');
  const [due, setDue] = useState<string | null>(null);
  /** True while the chip follows the typed words; picking a date by hand stops that. */
  const [auto, setAuto] = useState(true);
  const { busy, error, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLSpanElement>(null);
  const found = auto ? readDue(text, today, ws) : null;
  // The words themselves, without the space the match starts with.
  const mark = found && { from: found.index + (text.slice(found.index).length - text.slice(found.index).trimStart().length), to: found.index + found.length };
  // A long title scrolls inside the input; the marks scroll with it.
  const followScroll = () => {
    if (mirror.current && input.current) mirror.current.style.transform = `translateX(${-input.current.scrollLeft}px)`;
  };
  useLayoutEffect(followScroll);
  const shownDue = auto ? (found?.day ?? null) : due;

  const add = async () => {
    const v = text.trim();
    if (!v) return;
    const title = found ? withoutDue(v, found) : v;
    // `run` gives undefined on failure; the call itself returns nothing, so say it worked.
    const ok = await run(async () => {
      await glossly.invoke('commitments:add', { text: title, due_at: shownDue, person_id: person?.id ?? null });
      return true;
    });
    if (!ok) return;
    setText('');
    setDue(null);
    setAuto(true);
    input.current?.focus();
  };
  return (
    <form
      className="quick-add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Plus size={16} strokeWidth={1.75} aria-hidden />
      <span className="quick-field">
        {/* The date words, marked under the input's own text (an input can't style part of it). */}
        {mark && (
          <span className="quick-mirror" aria-hidden ref={mirror}>
            {text.slice(0, mark.from)}
            <mark>{text.slice(mark.from, mark.to)}</mark>
            {text.slice(mark.to)}
          </span>
        )}
        <input
          ref={input}
          value={text}
          placeholder={person ? `Add a task for ${person.name}` : 'Add a task, e.g. Send Jordan the deck by Friday'}
          aria-label="New task"
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          onScroll={followScroll}
          onSelect={followScroll}
        />
      </span>
      <span className="quick-hint">Enter to add</span>
      <DatePicker
        variant="chip"
        label="Due date for the new task"
        value={shownDue}
        text={shownDue ? relDay(shownDue, today) : undefined}
        noneText="Add date"
        disabled={busy}
        onChange={(d) => {
          setAuto(false);
          setDue(d);
        }}
      />
      {error && <span className="error small">{error}</span>}
    </form>
  );
}

/** "Completed … Undo" for a few seconds after a task is checked off. Portaled so fixed sits on the window (the page's enter animation would otherwise pin it to the section). */
function UndoToast({ task, onUndo, onGone }: { task: CommitmentView; onUndo: () => void; onGone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onGone, 5000);
    return () => clearTimeout(t);
  }, [task, onGone]);
  return createPortal(
    <div className="toast-bar" role="status">
      <span className="clip1">Completed "{task.text}"</span>
      <button type="button" className="sm" onClick={onUndo}>
        Undo
      </button>
    </div>,
    document.body,
  );
}

/**
 * Tasks (decision 40, after Google Tasks, Things, and Todoist): quick add, filter chips and a
 * person filter, then Overdue, Today, each later day, No date, and a Completed list that starts
 * closed. Rows: the round check, the title edited in place, who it's for or from, and hover
 * actions; only overdue rows show a date, since the section says the rest.
 */
export function TasksTab() {
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [personId, setPersonId] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [undo, setUndo] = useState<CommitmentView | null>(null);
  const today = toDay(new Date());
  const open = useLive(useCallback(() => glossly.invoke('commitments:list', { status: 'open', ...(personId && { personId }) }), [personId]));
  const done = useLive(useCallback(() => glossly.invoke('commitments:list', { status: 'done', ...(personId && { personId }) }), [personId]));
  const people = useLive(useCallback(() => glossly.invoke('people:list', { query: '' }), []));

  const setStatus = (t: CommitmentView, isDone: boolean) => {
    void glossly.invoke('commitments:set-status', { id: t.id, status: isDone ? 'done' : 'open' }).then(() => setUndo(isDone ? t : null));
  };
  const clearUndo = useCallback(() => setUndo(null), []);

  const all = open ?? [];
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, all.filter((t) => matchesFilter(t, f)).length])) as Record<TaskFilter, number>;
  const s = taskSections(
    all.filter((t) => matchesFilter(t, filter)),
    today,
  );
  const finished = [...(done ?? [])].filter((t) => matchesFilter(t, filter)).sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  const shown = s.overdue.length + s.today.length + s.days.length + s.noDate.length;
  // Rows that arrive after the list first loaded (a task just added or reopened) rise in; the
  // list itself appears with the page (decision 45).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!open || !done) return;
    seen.current ??= new Set();
    for (const t of [...open, ...done]) seen.current.add(`${t.id}:${t.status}`);
  });
  const row = (t: CommitmentView, showDue = false) => (
    <TaskRow key={`${t.id}:${t.text}:${t.status}`} t={t} today={today} showDue={showDue} fresh={seen.current !== null && !seen.current.has(`${t.id}:${t.status}`)} onDone={setStatus} />
  );

  return (
    <section className="tasks-tab">
      <div className="tasks-head">
        <div className="grow">
          <h2>Tasks</h2>
          <p className="muted small">
            {counts.all} open
            {s.overdue.length > 0 && filter === 'all' && <span className="error"> · {s.overdue.length} overdue</span>}
          </p>
        </div>
        <Select
          size="sm"
          label="Person"
          value={personId}
          onChange={setPersonId}
          options={[{ value: '', label: 'Everyone', icon: <UsersRound size={16} strokeWidth={1.75} aria-hidden /> }, ...(people ?? []).map((p, i) => ({ value: p.id, label: p.name, separator: i === 0, hint: p.open ? String(p.open) : undefined }))]}
        />
      </div>
      <QuickAdd today={today} person={(people ?? []).find((p) => p.id === personId) ?? null} />
      <div className="task-filters" role="group" aria-label="Show">
        {FILTERS.map(([f, label]) => (
          <button key={f} type="button" className="fchip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {label}
            <span className="n">{counts[f]}</span>
          </button>
        ))}
      </div>

      {!open ? (
        <p className="muted small">Loading…</p>
      ) : shown === 0 ? (
        <div className="empty-state">
          <strong>Nothing open</strong>
          {filter === 'them' ? 'Nobody owes you anything right now.' : 'Add a task above, or select a message and pick Tasks and events.'}
        </div>
      ) : (
        <>
          {s.overdue.length > 0 && (
            <Section title="Overdue" count={s.overdue.length} tone="overdue">
              {s.overdue.map((t) => row(t, true))}
            </Section>
          )}
          {s.today.length > 0 && (
            <Section title="Today" count={s.today.length} when={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}>
              {s.today.map((t) => row(t))}
            </Section>
          )}
          {s.days.map((d) => (
            <Section key={d.day} title={relDay(d.day, today)} count={d.tasks.length}>
              {d.tasks.map((t) => row(t))}
            </Section>
          ))}
          {s.noDate.length > 0 && (
            <Section title="No date" count={s.noDate.length}>
              {s.noDate.map((t) => row(t))}
            </Section>
          )}
        </>
      )}

      {finished.length > 0 && (
        <div className="task-section">
          <button type="button" className="collapse" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
            Completed
            <span className="n">{finished.length}</span>
          </button>
          {showDone && <ul className="task-list">{finished.map((t) => row(t))}</ul>}
        </div>
      )}
      {undo && <UndoToast task={undo} onGone={clearUndo} onUndo={() => setStatus(undo, false)} />}
    </section>
  );
}
