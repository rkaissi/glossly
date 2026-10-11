import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ExternalLink, Info, RotateCcw } from 'lucide-react';
import type { CalendarEvent, CommitmentView, EventCandidate, EventSaveRow, OverlayState, PromiseRow, PromiseSaveRow, PromisesByRules, PromisesResult } from '@glossly/core/api';
import { glossly } from '../bridge';
import { DatePicker } from '../controls/DatePicker';
import { addMinutes } from '../controls/logic';
import { Select } from '../controls/Select';
import { TimePicker } from '../controls/TimePicker';
import { Checkbox, TaskCheck } from '../controls/Toggles';
import { formatDue, formatEventTime, joinStamp, splitStamp } from '../dates';
import { PersonFields } from '../people/PersonForm';
import { draftToCreate, type PersonDraft } from '../people/draft';

/** Which person a row is saved with: the matched record, a new one from the name, or nobody. */
type PersonChoice = 'match' | 'new' | 'none';

interface Draft extends PromiseRow {
  person: PersonChoice;
}

const initialChoice = (r: PromiseRow): PersonChoice => (r.match ? 'match' : r.person_name ? 'new' : 'none');

/** A new person starts from what Who's reader found (email, handle, note, relationship), else just the name. */
function draftForRow(r: PromiseRow): PersonDraft {
  return {
    name: r.person_name ?? '',
    email: r.details?.email ?? '',
    handle: r.details?.handle ?? '',
    note: r.details?.note ?? '',
    relationship: r.details?.relationship ?? 'other',
  };
}

/** A new person is created with the fields as the user left them in "New people" (the same fields as Who's Create person). */
function toSave(d: Draft, people: Record<string, PersonDraft>): PromiseSaveRow {
  if (d.existing) return { change: d.change, existingId: d.existing.id, owner: d.owner, text: d.text, due_at: d.due_at, person: null };
  let person: PromiseSaveRow['person'] = null;
  if (d.person === 'match' && d.match) person = { kind: 'existing', id: d.match.personId };
  else if (d.person === 'new' && d.person_name) {
    const f = draftToCreate(people[d.person_name] ?? draftForRow(d));
    person = { kind: 'new', name: f.name || d.person_name, email: f.email ?? null, handle: f.handle ?? null, note: f.note ?? null, relationship: f.relationship };
  }
  return { owner: d.owner, text: d.text.trim(), due_at: d.due_at, person };
}

/**
 * The people the selected rows will create, once each, with the same fields as adding a person
 * in Who is this (prefilled from Who's reader). They are created when the promises are saved.
 */
function NewPeople({ rows, people, onChange }: { rows: Draft[]; people: Record<string, PersonDraft>; onChange: (key: string, d: PersonDraft) => void }) {
  const seen = new Map<string, Draft>();
  for (const r of rows) if (r.selected && !r.existing && r.person === 'new' && r.person_name && !seen.has(r.person_name)) seen.set(r.person_name, r);
  if (seen.size === 0) return null;
  return (
    <div className="new-people">
      <h4>New people</h4>
      <ul>
        {[...seen.values()].map((r) => {
          const key = r.person_name!;
          return (
            <li key={key}>
              <PersonFields value={people[key] ?? draftForRow(r)} onChange={(d) => onChange(key, d)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; result: Extract<PromisesResult, { ok: false }> }
  | { kind: 'review' }
  | { kind: 'saving' }
  | { kind: 'saved'; saved: number; created: number; updated: number; events: number };

/** An event as the panel edits it: day and times as input values. */
interface EventDraft {
  key: string;
  title: string;
  day: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  personIds: string[];
  when_phrase: string | null;
  selected: boolean;
}

function toEventDraft(e: EventCandidate): EventDraft {
  const s = splitStamp(e.starts_at);
  return {
    key: e.key,
    title: e.title,
    day: s.day,
    start: e.all_day ? '' : s.time,
    end: e.all_day ? '' : splitStamp(e.ends_at).time,
    location: e.location ?? '',
    attendees: e.attendees,
    personIds: e.people.map((p) => p.personId),
    when_phrase: e.when_phrase,
    selected: e.selected,
  };
}

function toEventSave(d: EventDraft): EventSaveRow {
  const allDay = !d.start;
  return {
    title: d.title.trim(),
    starts_at: joinStamp(d.day, d.start),
    // An end at or before the start is dropped; the Agenda shows the start alone.
    ends_at: allDay || !d.end || d.end <= d.start ? null : joinStamp(d.day, d.end),
    all_day: allDay,
    location: d.location.trim() || null,
    attendees: d.attendees,
    personIds: d.personIds,
  };
}

/** Minutes from one "HH:MM" to a later one. */
const minutesBetween = (a: string, b: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return m(b) - m(a);
};

const canSaveEvent = (d: EventDraft) => d.selected && d.title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.day);

/** A candidate event: what, when (day, start, end; no start is all day), where, and who. */
function EventRowView({ d, onChange }: { d: EventDraft; onChange: (patch: Partial<EventDraft>) => void }) {
  return (
    <li className={`promise event${d.selected ? '' : ' off'}`}>
      <Checkbox
        checked={d.selected}
        label={d.selected ? 'Skip this event' : 'Add this event'}
        tabIndex={-1}
        onChange={(selected) => onChange({ selected })}
      />
      <div className="promise-body">
        <input className="promise-text" value={d.title} maxLength={200} aria-label="Event" spellCheck={false} onChange={(e) => onChange({ title: e.target.value })} />
        <div className="promise-meta event-when" title={d.when_phrase ? `"${d.when_phrase}"` : undefined}>
          <DatePicker variant="chip" label="Day" value={d.day || null} allowNone={false} overdue={false} tabIndex={-1} onChange={(day) => day && onChange({ day })} />
          <TimePicker
            size="sm"
            label="Starts"
            value={d.start}
            placeholder="All day"
            allowEmpty
            tabIndex={-1}
            // A new start keeps the event's length, or makes it an hour long.
            onChange={(start) => onChange({ start, end: !start ? '' : d.end && d.start && d.end > d.start ? addMinutes(start, minutesBetween(d.start, d.end)) : d.end > start ? d.end : addMinutes(start, 60) })}
          />
          {d.start && (
            <>
              <span className="muted">to</span>
              <TimePicker size="sm" label="Ends" value={d.end} placeholder="End" allowEmpty tabIndex={-1} onChange={(end) => onChange({ end })} />
            </>
          )}
        </div>
        <div className="promise-meta">
          <input className="event-place" placeholder="Where" aria-label="Where" tabIndex={-1} value={d.location} maxLength={300} onChange={(e) => onChange({ location: e.target.value })} />
          {d.attendees.length > 0 && <span className="muted small clip1">With {d.attendees.join(', ')}</span>}
        </div>
      </div>
    </li>
  );
}

const CHANGE_LABEL: Record<Exclude<PromiseRow['change'], 'new'>, string> = { same: 'Already open', done: 'Mark done', moved: 'New date' };

/** "You owe Jordan", "Jordan owes you", or "Your todo". */
function owesLabel(t: Pick<CommitmentView, 'owner' | 'person_name'>): string {
  if (t.owner === 'them') return `${t.person_name ?? 'They'} owe${t.person_name ? 's' : ''} you`;
  return t.person_name ? `You owe ${t.person_name}` : 'Your todo';
}

/** A row about a task you already have: finish it, move it, or (same) nothing to do. */
function ExistingRow({ d, highlight, onChange, onFocusRow }: { d: Draft; highlight: boolean; onChange: (patch: Partial<Draft>) => void; onFocusRow: () => void }) {
  const was = formatDue(d.existing!.due_at);
  const now = formatDue(d.due_at);
  const same = d.change === 'same';
  return (
    <li className={`promise existing${d.selected ? '' : ' off'}${highlight ? ' highlight' : ''}`} onFocus={onFocusRow}>
      <Checkbox
        checked={d.selected}
        label={d.selected ? 'Leave it' : CHANGE_LABEL[d.change as 'done']}
        tabIndex={-1}
        disabled={same}
        onChange={(selected) => onChange({ selected })}
      />
      <div className="promise-body">
        <span className="promise-text static">{d.text}</span>
        <div className="promise-meta">
          <span className="tag">{CHANGE_LABEL[d.change as 'done']}</span>
          <span className="muted small">{owesLabel(d)}</span>
          <span className="spacer" />
          {d.change === 'moved' ? (
            <DatePicker
              variant="chip"
              label="New due date"
              value={d.due_at?.slice(0, 10) ?? null}
              text={`${d.existing!.due_at ? `${was.label} → ` : ''}${now.label}`}
              title={d.due_phrase ? `"${d.due_phrase}"` : undefined}
              tabIndex={-1}
              onChange={(day) => onChange({ due_at: day })}
            />
          ) : (
            d.existing!.due_at && <span className={`small${was.overdue ? ' overdue' : ' muted'}`}>{was.label}</span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Open tasks with the people in the message that the message doesn't touch (decision 36): what
 * you already owe them and what they owe you. Done and a date change apply at once.
 */
function OpenTasks({ tasks, onDone, onDue }: { tasks: CommitmentView[]; onDone: (t: CommitmentView) => void; onDue: (t: CommitmentView, due: string | null) => void }) {
  if (tasks.length === 0) return null;
  const names = [...new Set(tasks.map((t) => t.person_name).filter((n): n is string => Boolean(n)))];
  return (
    <div className="open-tasks">
      <h4>Already open with {names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : 'these people'}</h4>
      <ul className="promise-list">
        {tasks.map((t) => {
          return (
            <li key={t.id} className="promise">
              <TaskCheck checked={false} label="Mark done" tabIndex={-1} onChange={() => onDone(t)} />
              <div className="promise-body">
                <span className="promise-text static">{t.text}</span>
                <div className="promise-meta">
                  <span className="muted small">{owesLabel(t)}</span>
                  <span className="spacer" />
                  <DatePicker variant="chip" label="Due date" value={t.due_at?.slice(0, 10) ?? null} noneText="No date" tabIndex={-1} onChange={(day) => onDue(t, day)} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Row({
  d,
  highlight,
  onChange,
  onFocusRow,
}: {
  d: Draft;
  highlight: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onFocusRow: () => void;
}) {
  return (
    <li className={`promise${d.selected ? '' : ' off'}${highlight ? ' highlight' : ''}`} onFocus={onFocusRow}>
      <Checkbox
        checked={d.selected}
        label={d.selected ? 'Skip this one' : 'Keep this one'}
        tabIndex={-1}
        onChange={(selected) => onChange({ selected })}
      />
      <div className="promise-body">
        <input className="promise-text" value={d.text} maxLength={300} aria-label="What" spellCheck={false} onChange={(e) => onChange({ text: e.target.value })} />
        <div className="promise-meta">
          <button
            className="owner"
            title="Switch who owes it"
            tabIndex={-1}
            onClick={() => onChange({ owner: d.owner === 'me' ? 'them' : 'me' })}
          >
            {d.owner === 'me' ? 'You owe' : 'They owe'}
          </button>
          <Select<PersonChoice>
            size="sm"
            label="Person"
            value={d.person}
            tabIndex={-1}
            onChange={(person) => onChange({ person })}
            options={[
              ...(d.match ? [{ value: 'match' as const, label: d.match.kind === 'fuzzy' ? `${d.match.name}?` : d.match.name }] : []),
              ...(d.person_name ? [{ value: 'new' as const, label: `New person: ${d.person_name}` }] : []),
              { value: 'none', label: 'No one' },
            ]}
          />
          <span className="spacer" />
          <DatePicker
            variant="chip"
            label="Due date"
            value={d.due_at?.slice(0, 10) ?? null}
            noneText={d.due_phrase ? `No date ("${d.due_phrase}")` : 'No date'}
            title={d.due_phrase ? `"${d.due_phrase}"` : 'No deadline in the text'}
            tabIndex={-1}
            onChange={(day) => onChange({ due_at: day })}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * Tasks (decision 36): what the message says (new tasks, and ones that finish or move a task you
 * already have), then the other open tasks with the same people. The user toggles rows, fixes a
 * name or date if needed, and Enter saves the selected ones.
 */
export function PromisesPanel({ s }: { s: OverlayState }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [rows, setRows] = useState<Draft[]>([]);
  const [meta, setMeta] = useState<{ author: string | null; authorIsMe: boolean; identitySet: boolean; byRules: PromisesByRules } | null>(null);
  const [hl, setHl] = useState(0);
  const [people, setPeople] = useState<Record<string, PersonDraft>>({});
  const [open, setOpen] = useState<CommitmentView[]>([]);
  const [events, setEvents] = useState<EventDraft[]>([]);
  const [sameDay, setSameDay] = useState<CalendarEvent[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const extract = async () => {
    setPhase({ kind: 'loading' });
    const r = await glossly.invoke('promises:extract', { sessionId: s.sessionId }).catch(
      (): PromisesResult => ({ ok: false, code: 'provider', message: 'The model call failed.' }),
    );
    if (!r.ok) {
      if (r.code !== 'aborted') setPhase({ kind: 'error', result: r });
      return;
    }
    setRows(r.rows.map((row) => ({ ...row, person: initialChoice(row) })));
    setMeta({ author: r.author, authorIsMe: r.authorIsMe, identitySet: r.identitySet, byRules: r.byRules });
    setOpen(r.open);
    setEvents(r.events.map(toEventDraft));
    setSameDay(r.sameDay);
    setHl(0);
    setPhase({ kind: 'review' });
  };

  useEffect(() => {
    void extract();
    // One extraction per panel; the session id never changes inside it.
  }, []);

  useEffect(() => {
    if (s.keyboard) panel.current?.focus();
  }, [s.keyboard, phase.kind]);

  const selected = rows.filter((r) => r.selected && r.text.trim());
  const eventsToSave = events.filter(canSaveEvent);
  const toSaveCount = selected.length + eventsToSave.length;
  const patchEvent = (key: string, p: Partial<EventDraft>) => setEvents((es) => es.map((e) => (e.key === key ? { ...e, ...p } : e)));
  const patch = (i: number, p: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = async () => {
    if (phase.kind !== 'review' || toSaveCount === 0) return;
    setPhase({ kind: 'saving' });
    try {
      const r = await glossly.invoke('promises:save', { sessionId: s.sessionId, rows: selected.map((d) => toSave(d, people)), events: eventsToSave.map(toEventSave) });
      setPhase({ kind: 'saved', ...r });
      panel.current?.focus();
    } catch {
      setPhase({ kind: 'review' });
    }
  };

  const markDone = (t: CommitmentView) => {
    setOpenError(null);
    glossly.invoke('commitments:set-status', { id: t.id, status: 'done' }).then(
      () => setOpen((ts) => ts.filter((x) => x.id !== t.id)),
      () => setOpenError("Couldn't mark it done."),
    );
  };
  const changeDue = (t: CommitmentView, due_at: string | null) => {
    setOpenError(null);
    glossly.invoke('commitments:update', { id: t.id, due_at }).then(
      () => setOpen((ts) => ts.map((x) => (x.id === t.id ? { ...x, due_at } : x))),
      () => setOpenError("Couldn't change the date."),
    );
  };

  const switchToAllModels = async () => {
    const r = await glossly.invoke('settings:set', { key: 'privacy', value: 'all' });
    if (!r.error) await extract();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const control = e.target instanceof Element && e.target.closest('[data-control]') !== null;
    const typing = e.target instanceof HTMLInputElement || control;
    if (phase.kind === 'saved' && e.key === 'Enter') {
      e.preventDefault();
      void glossly.invoke('bar:close', { sessionId: s.sessionId });
      return;
    }
    if (phase.kind !== 'review') return;
    if (e.key === 'Enter' && !control) {
      e.preventDefault();
      void save();
    } else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setHl((h) => (h + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (!typing && e.key === ' ' && rows[hl] && rows[hl]!.change !== 'same') {
      e.preventDefault();
      patch(hl, { selected: !rows[hl]!.selected });
    }
  };

  return (
    <div className="panel promises" tabIndex={-1} ref={panel} onKeyDown={onKeyDown}>
      {phase.kind === 'loading' && <p className="thinking">Finding tasks and events…</p>}

      {phase.kind === 'error' && (
        <div className="answer-error">
          <span className="error">{phase.result.message}</span>
          {phase.result.code === 'no_model' && <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Add a key</button>}
          {phase.result.code === 'local_only' && (
            <>
              <button onClick={() => void switchToAllModels()}>Use all models and try again</button>
              <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Set up a local model</button>
            </>
          )}
          {phase.result.code !== 'no_model' && phase.result.code !== 'local_only' && (
            <button onClick={() => void extract()}>
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
              Try again
            </button>
          )}
        </div>
      )}

      {(phase.kind === 'review' || phase.kind === 'saving') && (
        <>
          {meta?.byRules && (
            <div className="inline-note">
              <Info size={14} strokeWidth={1.75} aria-hidden />
              <span>
                {meta.byRules === 'local_only' ? 'Local only is on with no local model' : 'No model is set up'}, so these were found by simple patterns. Check
                each one.
              </span>
              <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>
                {meta.byRules === 'local_only' ? 'Set up a local model' : 'Add a key'}
              </button>
            </div>
          )}
          {meta && !meta.identitySet && (
            <div className="inline-note">
              <Info size={14} strokeWidth={1.75} aria-hidden />
              <span>Add your name so Glossly knows which tasks are yours.</span>
              <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'profile' })}>
                Add your name
              </button>
            </div>
          )}
          {rows.length === 0 ? (
            events.length === 0 && <p className="muted">{open.length ? 'Nothing new in this message.' : 'No tasks or events in this selection.'}</p>
          ) : (
            <>
              <h2>
                {meta?.authorIsMe ? 'From your message' : meta?.author ? `From ${meta.author}'s message` : 'Found in the selection'}
              </h2>
              <ul className="promise-list">
                {rows.map((d, i) =>
                  d.existing ? (
                    <ExistingRow key={d.key} d={d} highlight={s.keyboard && i === hl} onChange={(p) => patch(i, p)} onFocusRow={() => setHl(i)} />
                  ) : (
                    <Row key={d.key} d={d} highlight={s.keyboard && i === hl} onChange={(p) => patch(i, p)} onFocusRow={() => setHl(i)} />
                  ),
                )}
              </ul>
              <NewPeople rows={rows} people={people} onChange={(key, d) => setPeople((m) => ({ ...m, [key]: d }))} />
            </>
          )}
          {events.length > 0 && (
            <div className="events">
              <h4>Events</h4>
              <ul className="promise-list">
                {events.map((d) => (
                  <EventRowView key={d.key} d={d} onChange={(p) => patchEvent(d.key, p)} />
                ))}
              </ul>
              {sameDay.length > 0 && (
                <p className="muted small">
                  Already that day: {sameDay.map((e) => `${e.title} (${formatEventTime(e)})`).join(', ')}
                </p>
              )}
            </div>
          )}
          <OpenTasks tasks={open} onDone={markDone} onDue={changeDue} />
          {openError && <p className="error small">{openError}</p>}
        </>
      )}

      {phase.kind === 'saved' && (
        <h2 className="saved-line">
          <Check size={17} strokeWidth={2} aria-hidden />
          <span>
            {[
              phase.saved > 0 && `Saved ${phase.saved} ${phase.saved === 1 ? 'task' : 'tasks'}`,
              phase.updated > 0 && `updated ${phase.updated}`,
              phase.events > 0 && `added ${phase.events} ${phase.events === 1 ? 'event' : 'events'}`,
            ]
              .filter(Boolean)
              .join(' · ')
              .replace(/^./, (c) => c.toUpperCase())}
            {phase.created > 0 && <span className="muted"> · added {phase.created === 1 ? '1 person' : `${phase.created} people`}</span>}
          </span>
        </h2>
      )}

      <div className="panel-foot">
        {phase.kind === 'saved' && (
          <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'agenda' })}>
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
            Open Agenda
          </button>
        )}
        <span className="spacer" />
        {(phase.kind === 'review' || phase.kind === 'saving') && rows.length + events.length > 0 && (
          <button className="primary" disabled={toSaveCount === 0 || phase.kind === 'saving'} onClick={() => void save()}>
            {phase.kind === 'saving' ? 'Saving…' : `Save ${toSaveCount}`}
          </button>
        )}
        {s.keyboard && (
          <span>
            {phase.kind === 'saved' ? (
              <>
                <kbd>Enter</kbd> done · <kbd>Esc</kbd> back
              </>
            ) : rows.length > 0 && phase.kind !== 'error' && phase.kind !== 'loading' ? (
              <>
                <kbd>↑↓</kbd> move · <kbd>Space</kbd> keep or skip · <kbd>Enter</kbd> save
              </>
            ) : (
              <>
                <kbd>Esc</kbd> back
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
