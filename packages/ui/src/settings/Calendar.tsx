import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Clock, MapPin, Plus, Trash2, UsersRound, X } from 'lucide-react';
import type { CalendarEvent, CommitmentView, PersonSummary, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { joinStamp } from '../dates';
import { DatePicker } from '../controls/DatePicker';
import { DateRangePicker } from '../controls/DateRangePicker';
import { addDays, addMonths, formatTime, fromDay, toDay, weekdayNames, weekStart, type Day, type DayRange } from '../controls/logic';
import { MenuList } from '../controls/Menu';
import { Popover } from '../controls/Popover';
import { TimePicker } from '../controls/TimePicker';
import { Segmented, Switch, TaskCheck } from '../controls/Toggles';
import { WeekStartContext } from '../controls/week';
import {
  DAY_MIN,
  durationLabel,
  eventDay,
  eventSpan,
  layoutDay,
  monthDays,
  monthTitle,
  rangeDays,
  shiftRange,
  snapMinutes,
  STEP,
  tint,
  toClock,
  toMinutes,
  weekTitle,
  type CalendarView,
} from './calendar-logic';
import { dueDay } from './tasks-logic';
import { useLive } from './useLive';
import './calendar.css';

/** Pixels per hour in Week, and the hour it opens scrolled to. */
const HOUR = 48;
const FIRST_HOUR = 7;

const VIEWS: [CalendarView, string][] = [
  ['month', 'Month'],
  ['week', 'Week'],
  ['agenda', 'Agenda'],
];

/** "10 AM", "12:30 PM". */
const shortTime = (m: number) => formatTime(toClock(Math.min(m, DAY_MIN - 1))).replace(':00 ', ' ');

/** What the editor edits: an event, or a new one (id null). */
interface Draft {
  id: string | null;
  title: string;
  day: Day;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  people: { id: string; name: string }[];
}

const toDraft = (e: CalendarEvent): Draft => {
  const span = eventSpan(e);
  return {
    id: e.id,
    title: e.title,
    day: eventDay(e),
    start: toClock(span.start),
    end: toClock(Math.min(span.end, DAY_MIN - 1)),
    allDay: e.all_day,
    location: e.location ?? '',
    people: e.people,
  };
};
const newDraft = (day: Day, start: number, end = start + 60): Draft => ({
  id: null,
  title: '',
  day,
  start: toClock(start),
  end: toClock(Math.min(end, DAY_MIN - 1)),
  allDay: false,
  location: '',
  people: [],
});

// ---------------------------------------------------------------- the editor

function AddPeople({ taken, onAdd }: { taken: string[]; onAdd: (p: PersonSummary) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const people = useLive(useCallback(() => glossly.invoke('people:list', { query: '' }), []));
  const left = (people ?? []).filter((p) => !taken.includes(p.id));
  return (
    <>
      <button ref={ref} type="button" className="ghost sm add-people" aria-expanded={open} disabled={people !== undefined && left.length === 0} onClick={() => setOpen((o) => !o)}>
        <Plus size={14} strokeWidth={1.75} aria-hidden />
        Add people
      </button>
      {open && (
        <Popover anchor={ref} onClose={(r) => (setOpen(false), r && ref.current?.focus())} label="Add people">
          <MenuList
            label="People"
            items={left.map((p) => ({ value: p.id, label: p.name }))}
            onPick={(id) => {
              setOpen(false);
              const p = left.find((x) => x.id === id);
              if (p) onAdd(p);
            }}
          />
        </Popover>
      )}
    </>
  );
}

/** The event editor (a popover beside the event): title, day, times or all day, place, people, delete. */
function EventEditor({ anchor, draft: initial, onClose }: { anchor: HTMLElement; draft: Draft; onClose: (saved: boolean) => void }) {
  const ref = useRef<HTMLElement | null>(anchor);
  ref.current = anchor;
  const [d, setD] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const len = toMinutes(d.end) - toMinutes(d.start);

  const save = async () => {
    const title = d.title.trim() || 'Untitled event';
    const starts_at = d.allDay ? d.day : joinStamp(d.day, d.start);
    const ends_at = d.allDay ? null : joinStamp(d.day, d.end);
    try {
      if (d.id) await glossly.invoke('calendar:update', { id: d.id, patch: { title, starts_at, ends_at, all_day: d.allDay, location: d.location.trim() || null, personIds: d.people.map((p) => p.id) } });
      else await glossly.invoke('calendar:add', { title, starts_at, ends_at, all_day: d.allDay, location: d.location.trim() || null, attendees: d.people.map((p) => p.name), personIds: d.people.map((p) => p.id) });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the event.");
    }
  };
  const remove = async () => {
    if (!d.id) return;
    await glossly.invoke('calendar:delete', { id: d.id });
    onClose(true);
  };

  return (
    <Popover anchor={ref} align="side" onClose={() => onClose(false)} label={d.id ? 'Edit event' : 'New event'} className="event-editor-pop">
      <form
        className="event-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input className="ee-title" value={d.title} placeholder="Add a title" aria-label="Title" maxLength={200} autoFocus={!d.id} data-autofocus={!d.id || undefined} onChange={(e) => set({ title: e.target.value })} />
        <div className="ee-row">
          <Clock size={16} strokeWidth={1.75} aria-hidden />
          <DatePicker className="ee-day" label="Day" value={d.day} allowNone={false} onChange={(day) => day && set({ day })} />
          {!d.allDay && (
            <>
              <TimePicker
                size="sm"
                label="Starts"
                value={d.start}
                // A new start keeps the event's length.
                onChange={(start) => set({ start, end: toClock(Math.min(toMinutes(start) + Math.max(len, STEP), DAY_MIN - 1)) })}
              />
              <span className="muted">–</span>
              <TimePicker size="sm" label="Ends" value={d.end} onChange={(end) => toMinutes(end) > toMinutes(d.start) && set({ end })} />
            </>
          )}
        </div>
        <div className="ee-row indent">
          <label className="ee-allday">
            <Switch label="All day" checked={d.allDay} onChange={(allDay) => set({ allDay })} />
            All day
          </label>
          {!d.allDay && <span className="muted small ee-len">{durationLabel(len)}</span>}
        </div>
        <div className="ee-row">
          <MapPin size={16} strokeWidth={1.75} aria-hidden />
          <input className="inline-input" value={d.location} placeholder="Add a place" aria-label="Place" maxLength={300} onChange={(e) => set({ location: e.target.value })} />
        </div>
        <div className="ee-row top">
          <UsersRound size={16} strokeWidth={1.75} aria-hidden />
          <div className="ee-people">
            {d.people.map((p) => (
              <span key={p.id} className="ee-person">
                <span className="avatar" aria-hidden>
                  {p.name
                    .split(/\s+/)
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)}
                </span>
                {p.name}
                <button type="button" className="chip-x" aria-label={`Remove ${p.name}`} onClick={() => set({ people: d.people.filter((x) => x.id !== p.id) })}>
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              </span>
            ))}
            <AddPeople taken={d.people.map((p) => p.id)} onAdd={(p) => set({ people: [...d.people, { id: p.id, name: p.name }] })} />
          </div>
        </div>
        {error && <p className="error small">{error}</p>}
        <div className="ee-foot">
          {confirming ? (
            // Where the trash button was, in the same order as every inline confirm.
            <>
              <span className="small">Delete this event?</span>
              <button type="button" className="danger sm" onClick={() => void remove()}>
                Delete
              </button>
              <button type="button" className="sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {d.id && (
                <button type="button" className="icon-btn sm danger" title="Delete event" aria-label="Delete event" onClick={() => setConfirming(true)}>
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                </button>
              )}
              <span className="grow" />
              <button type="button" className="ghost sm" onClick={() => onClose(false)}>
                Cancel
              </button>
              <button type="submit" className="primary sm">
                {d.id ? 'Save' : 'Add event'}
              </button>
            </>
          )}
        </div>
      </form>
    </Popover>
  );
}

// ---------------------------------------------------------------- shared bits

/** A task on its due day: a small round check and the text (Month and Week's all-day row). */
function MiniTask({ t, today, onToggle }: { t: CommitmentView; today: Day; onToggle: (t: CommitmentView) => void }) {
  const done = t.status !== 'open';
  const late = !done && (dueDay(t) ?? today) < today;
  return (
    <button type="button" className={`mini-task${done ? ' done' : ''}${late ? ' late' : ''}`} title={done ? 'Reopen' : 'Mark done'} onClick={(e) => (e.stopPropagation(), onToggle(t))}>
      <span className="mini-tick" aria-hidden />
      <span className="clip1">{t.text}</span>
    </button>
  );
}

type Open = (e: CalendarEvent, el: HTMLElement) => void;

// ---------------------------------------------------------------- Month

function MonthView({ cursor, today, events, tasks, onOpen, onNew, onToggle, onMore }: { cursor: Day; today: Day; events: CalendarEvent[]; tasks: CommitmentView[]; onOpen: Open; onNew: (day: Day, el: HTMLElement) => void; onToggle: (t: CommitmentView) => void; onMore: (day: Day) => void }) {
  const ws = useContext(WeekStartContext);
  const days = monthDays(cursor, ws);
  const MAX = 3;
  return (
    <div className="cal-month" style={{ '--weeks': days.length / 7 } as CSSProperties}>
      <div className="cal-month-dow">
        {weekdayNames(ws).map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <div className="cal-month-grid">
        {days.map((day) => {
          const evs = events.filter((e) => eventDay(e) === day).sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.starts_at.localeCompare(b.starts_at));
          const ts = tasks.filter((t) => dueDay(t) === day);
          const items = [...evs.map((e) => ({ e })), ...ts.map((t) => ({ t }))];
          const shown = items.slice(0, items.length > MAX ? MAX - 1 : MAX);
          const dow = fromDay(day).getDay();
          return (
            <div
              key={day}
              className={`cal-mcell${day.slice(0, 7) !== cursor.slice(0, 7) ? ' out' : ''}${day === today ? ' today' : ''}${dow === 0 || dow === 6 ? ' weekend' : ''}`}
              onClick={(e) => onNew(day, e.currentTarget)}
            >
              <span className="dnum">{day.endsWith('-01') ? fromDay(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : Number(day.slice(8))}</span>
              {shown.map((x) =>
                'e' in x ? (
                  <button
                    key={x.e.id}
                    type="button"
                    className={`mitem ev${x.e.all_day ? ' allday' : ''}`}
                    data-tint={tint(x.e.id)}
                    onClick={(ev) => (ev.stopPropagation(), onOpen(x.e, ev.currentTarget))}
                  >
                    {!x.e.all_day && <span className="time">{shortTime(eventSpan(x.e).start)}</span>}
                    <span className="clip1">{x.e.title}</span>
                  </button>
                ) : (
                  <MiniTask key={x.t.id} t={x.t} today={today} onToggle={onToggle} />
                ),
              )}
              {items.length > shown.length && (
                <button type="button" className="more" onClick={(e) => (e.stopPropagation(), onMore(day))}>
                  {items.length - shown.length} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Week

type Drag = { kind: 'create'; day: Day; anchor: number; start: number; end: number; moved: boolean } | { kind: 'resize'; id: string; start: number; end: number } | { kind: 'move'; id: string; day: Day; start: number; len: number; grab: number; x0: number; y0: number; moving: boolean };

/**
 * Week: events by time, overlapping ones side by side, tasks in the all-day row. Google
 * Calendar's gestures: drag on empty time to create, an event's bottom edge to resize, an
 * event to move it (also to another day); everything snaps to 15 minutes.
 */
function WeekView({ cursor, today, events, tasks, draft, onOpen, onCreate, onChange, onToggle }: { cursor: Day; today: Day; events: CalendarEvent[]; tasks: CommitmentView[]; draft: { day: Day; start: number; end: number } | null; onOpen: Open; onCreate: (day: Day, start: number, end: number, el: HTMLElement) => void; onChange: (e: CalendarEvent, day: Day, start: number, end: number) => void; onToggle: (t: CommitmentView) => void }) {
  const ws = useContext(WeekStartContext);
  const start = weekStart(cursor, ws);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<Map<Day, HTMLDivElement>>(new Map());
  const draftEl = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** A block just drawn by dragging, kept on screen until the editor opens beside it. */
  const [created, setCreated] = useState<{ day: Day; start: number; end: number } | null>(null);
  const [now, setNow] = useState(() => new Date());

  useLayoutEffect(() => {
    if (!created || !draftEl.current) return;
    onCreate(created.day, created.start, created.end, draftEl.current);
    setCreated(null);
  }, [created, onCreate]);

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = FIRST_HOUR * HOUR;
  }, [start]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const colAt = (x: number, y: number): Day | null => {
    for (const [day, el] of cols.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top - 40 && y <= r.bottom + 40) return day;
    }
    return null;
  };
  const yIn = (day: Day, y: number) => y - (cols.current.get(day)?.getBoundingClientRect().top ?? 0);

  /** Follows the mouse until it's released; `latest` keeps the newest drag state for mouseup. */
  const follow = (first: Drag, move: (d: Drag, e: MouseEvent) => Drag, up: (d: Drag) => void, cursorStyle: string) => {
    let latest = first;
    setDrag(first);
    document.body.style.cursor = cursorStyle;
    document.body.style.userSelect = 'none';
    const mv = (e: MouseEvent) => setDrag((latest = move(latest, e)));
    const done = () => {
      removeEventListener('mousemove', mv);
      removeEventListener('mouseup', done);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDrag(null);
      up(latest);
    };
    addEventListener('mousemove', mv);
    addEventListener('mouseup', done);
  };

  const onColDown = (day: Day) => (e: ReactMouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.wblock')) return;
    e.preventDefault();
    const anchor = Math.min(Math.floor(yIn(day, e.clientY) / HOUR * 4) * STEP, DAY_MIN - STEP);
    follow(
      { kind: 'create', day, anchor, start: anchor, end: anchor + STEP, moved: false },
      (d, m) => {
        if (d.kind !== 'create') return d;
        const cur = snapMinutes(yIn(day, m.clientY), HOUR);
        const moved = d.moved || Math.abs(cur - anchor) >= STEP;
        return { ...d, moved, start: Math.min(anchor, cur), end: Math.max(anchor + STEP, cur) };
      },
      (d) => {
        if (d.kind !== 'create') return;
        // A click without a drag makes an hour-long event.
        setCreated({ day, start: d.start, end: d.moved ? d.end : Math.min(d.start + 60, DAY_MIN) });
      },
      'ns-resize',
    );
  };

  const onBlockDown = (ev: CalendarEvent) => (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const span = eventSpan(ev);
    const day = eventDay(ev);
    if ((e.target as HTMLElement).classList.contains('rs')) {
      follow(
        { kind: 'resize', id: ev.id, start: span.start, end: span.end },
        (d, m) => (d.kind === 'resize' ? { ...d, end: Math.max(d.start + STEP, snapMinutes(yIn(day, m.clientY), HOUR)) } : d),
        (d) => d.kind === 'resize' && d.end !== span.end && onChange(ev, day, d.start, d.end),
        'ns-resize',
      );
      return;
    }
    const el = e.currentTarget as HTMLElement;
    const grab = snapMinutes(yIn(day, e.clientY), HOUR) - span.start;
    follow(
      { kind: 'move', id: ev.id, day, start: span.start, len: span.end - span.start, grab, x0: e.clientX, y0: e.clientY, moving: false },
      (d, m) => {
        if (d.kind !== 'move') return d;
        if (!d.moving && Math.hypot(m.clientX - d.x0, m.clientY - d.y0) < 4) return d;
        const to = colAt(m.clientX, m.clientY) ?? d.day;
        return { ...d, moving: true, day: to, start: Math.max(0, Math.min(DAY_MIN - d.len, snapMinutes(yIn(to, m.clientY), HOUR) - d.grab)) };
      },
      (d) => {
        if (d.kind !== 'move') return;
        if (!d.moving) onOpen(ev, el);
        else if (d.day !== day || d.start !== span.start) onChange(ev, d.day, d.start, d.start + d.len);
      },
      'grabbing',
    );
  };

  /** Where each event draws, with a drag in progress applied. */
  const placed = events
    .filter((e) => !e.all_day)
    .map((e) => {
      const span = eventSpan(e);
      let day = eventDay(e);
      let { start: s, end: en } = span;
      if (drag?.kind === 'resize' && drag.id === e.id) en = drag.end;
      if (drag?.kind === 'move' && drag.id === e.id && drag.moving) ((day = drag.day), (s = drag.start), (en = drag.start + drag.len));
      return { e, day, start: s, end: en };
    });
  const draftShown = drag?.kind === 'create' ? { day: drag.day, start: drag.start, end: drag.end } : (created ?? draft);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div className="cal-week">
      <div className="wk-head">
        <div />
        {days.map((d) => (
          <div key={d} className={d === today ? 'today' : undefined}>
            {weekdayNames(0)[fromDay(d).getDay()]} <b>{Number(d.slice(8))}</b>
          </div>
        ))}
      </div>
      <div className="wk-all">
        <div className="lbl">All day</div>
        {days.map((d) => (
          <div key={d} className="col">
            {events
              .filter((e) => e.all_day && eventDay(e) === d)
              .map((e) => (
                <button key={e.id} type="button" className="mitem ev allday" data-tint={tint(e.id)} onClick={(ev) => onOpen(e, ev.currentTarget)}>
                  <span className="clip1">{e.title}</span>
                </button>
              ))}
            {tasks
              .filter((t) => dueDay(t) === d)
              .map((t) => (
                <MiniTask key={t.id} t={t} today={today} onToggle={onToggle} />
              ))}
          </div>
        ))}
      </div>
      <div className="wk-scroll" ref={scroller}>
        <div className="wk-grid" style={{ '--hour': `${HOUR}px` } as CSSProperties}>
          <div className="wk-times">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h}>{h === 0 ? '' : shortTime(h * 60)}</div>
            ))}
          </div>
          {days.map((d) => {
            const here = placed.filter((p) => p.day === d);
            const lay = layoutDay([...here.map((p) => ({ id: p.e.id, start: p.start, end: p.end })), ...(draftShown?.day === d ? [{ id: '__draft', start: draftShown.start, end: draftShown.end }] : [])]);
            const dow = fromDay(d).getDay();
            return (
              <div
                key={d}
                ref={(el) => void (el ? cols.current.set(d, el) : cols.current.delete(d))}
                className={`wk-col${dow === 0 || dow === 6 ? ' weekend' : ''}`}
                onMouseDown={onColDown(d)}
              >
                {here.map((p) => {
                  const l = lay.get(p.e.id)!;
                  const h = ((p.end - p.start) / 60) * HOUR;
                  return (
                    <div
                      key={p.e.id}
                      className={`wblock ev${h < 36 ? ' short' : ''}${drag?.kind === 'move' && drag.id === p.e.id && drag.moving ? ' moving' : ''}`}
                      data-tint={tint(p.e.id)}
                      style={{ '--start': p.start, '--len': p.end - p.start, '--col': l.col, '--cols': l.cols } as CSSProperties}
                      onMouseDown={onBlockDown(p.e)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${p.e.title}, ${shortTime(p.start)} to ${shortTime(p.end)}`}
                      onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), onOpen(p.e, k.currentTarget))}
                    >
                      <div className="t">{p.e.title}</div>
                      <div className="m">
                        {shortTime(p.start)} – {shortTime(p.end)}
                        {p.e.location ? ` · ${p.e.location}` : ''}
                      </div>
                      <span className="rs" title="Drag to change the end" />
                    </div>
                  );
                })}
                {draftShown?.day === d && (
                  <div
                    ref={draftEl}
                    className="wblock draft"
                    style={{ '--start': draftShown.start, '--len': draftShown.end - draftShown.start, '--col': lay.get('__draft')!.col, '--cols': lay.get('__draft')!.cols } as CSSProperties}
                  >
                    <div className="t">New event</div>
                    <div className="m">
                      {shortTime(draftShown.start)} – {shortTime(draftShown.end)}
                    </div>
                  </div>
                )}
                {d === today && <div className="now-line" style={{ '--start': nowMin } as CSSProperties} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Agenda

function AgendaView({ range, today, events, tasks, onOpen, onToggle }: { range: DayRange; today: Day; events: CalendarEvent[]; tasks: CommitmentView[]; onOpen: Open; onToggle: (t: CommitmentView) => void }) {
  const rows = rangeDays(range)
    .map((day) => ({
      day,
      evs: events.filter((e) => eventDay(e) === day).sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.starts_at.localeCompare(b.starts_at)),
      ts: tasks.filter((t) => dueDay(t) === day),
    }))
    .filter((r) => r.evs.length || r.ts.length);
  if (rows.length === 0)
    return (
      <div className="empty-state">
        <strong>Nothing in these days</strong>
        Pick another range, or add an event.
      </div>
    );
  return (
    <div className="cal-agenda">
      {rows.map(({ day, evs, ts }) => (
        <div key={day} className={`aday${day === today ? ' today' : ''}`}>
          <div className="d">
            <b>{Number(day.slice(8))}</b>
            {day === today && <span className="today-pill">Today</span>}
            <span>
              {fromDay(day).toLocaleDateString('en-US', { weekday: 'long' })}, {fromDay(day).toLocaleDateString('en-US', { month: 'short' })}
            </span>
          </div>
          <div>
            {evs.map((e) => {
              const span = eventSpan(e);
              return (
                <button key={e.id} type="button" className="aitem ev" data-tint={tint(e.id)} onClick={(ev) => onOpen(e, ev.currentTarget)}>
                  <span className="time">{e.all_day ? 'All day' : `${shortTime(span.start)} – ${shortTime(span.end)}`}</span>
                  <span className="bar" aria-hidden />
                  <span className="main">
                    <span className="t">{e.title}</span>
                    {(e.location || e.attendees.length > 0) && (
                      <span className="m">
                        {e.location && (
                          <span>
                            <MapPin size={12} strokeWidth={1.75} aria-hidden /> {e.location}
                          </span>
                        )}
                        {e.attendees.length > 0 && (
                          <span>
                            <UsersRound size={12} strokeWidth={1.75} aria-hidden /> {e.attendees.join(', ')}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {ts.map((t) => (
              <div key={t.id} className={`aitem task${t.status !== 'open' ? ' done' : ''}`}>
                <span className="time">{t.status === 'open' && day < today ? <span className="error">Overdue</span> : 'Task'}</span>
                <TaskCheck checked={t.status !== 'open'} label={t.status !== 'open' ? 'Reopen' : 'Mark done'} onChange={() => onToggle(t)} />
                <span className="main">
                  <span className="t">{t.text}</span>
                  {t.person_name && (
                    <span className="m">
                      <span>
                        {t.owner === 'them' ? 'Waiting on' : 'For'} {t.person_name}
                      </span>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the tab

/**
 * Calendar (decision 40, after Google Calendar and Notion Calendar): Month, Week, and Agenda
 * with a date range, events as tinted glass, tasks on their due day (toggleable), and an editor
 * beside each event. The toolbar keeps one shape in every view; the view is remembered.
 */
export function CalendarTab({ view }: { view: SettingsView }) {
  const ws = useContext(WeekStartContext);
  const today = toDay(new Date());
  const [mode, setMode] = useState<CalendarView>(view.settings.calendarView);
  /** The view was switched here (not just opened with the page), so it settles in (decision 45). */
  const [switched, setSwitched] = useState(false);
  const [cursor, setCursor] = useState(today);
  const [range, setRange] = useState<DayRange>({ from: today, to: addDays(today, 13) });
  const [showTasks, setShowTasks] = useState(true);
  const [editing, setEditing] = useState<{ draft: Draft; anchor: HTMLElement } | null>(null);
  const [weekDraft, setWeekDraft] = useState<{ day: Day; start: number; end: number } | null>(null);

  // The days on screen, which is what gets loaded.
  const shown: DayRange =
    mode === 'agenda' ? range : mode === 'week' ? { from: weekStart(cursor, ws), to: addDays(weekStart(cursor, ws), 6) } : (() => {
      const d = monthDays(cursor, ws);
      return { from: d[0]!, to: d[d.length - 1]! };
    })();
  const events = useLive(useCallback(() => glossly.invoke('calendar:list', { from: shown.from, to: shown.to }), [shown.from, shown.to])) ?? [];
  const allTasks = useLive(useCallback(() => glossly.invoke('commitments:list', {}), [])) ?? [];
  const tasks = showTasks ? allTasks.filter((t) => t.status !== 'dropped' && dueDay(t) !== null && dueDay(t)! >= shown.from && dueDay(t)! <= shown.to) : [];

  const pickMode = (m: CalendarView) => {
    setMode(m);
    setSwitched(true);
    void glossly.invoke('settings:set', { key: 'calendarView', value: m });
  };
  const step = (dir: -1 | 1) => {
    if (mode === 'agenda') setRange((r) => shiftRange(r, dir));
    else setCursor((c) => (mode === 'month' ? addMonths(c, dir) : addDays(c, 7 * dir)));
  };
  const toggleTask = (t: CommitmentView) => void glossly.invoke('commitments:set-status', { id: t.id, status: t.status === 'open' ? 'done' : 'open' });
  const open: Open = (e, el) => setEditing({ draft: toDraft(e), anchor: el });
  const closeEditor = () => {
    setEditing(null);
    setWeekDraft(null);
  };
  const newButton = useRef<HTMLButtonElement>(null);
  const onCreate = useCallback((day: Day, start: number, end: number, el: HTMLElement) => {
    setWeekDraft({ day, start, end });
    setEditing({ draft: newDraft(day, start, end), anchor: el });
  }, []);

  return (
    <section className="calendar-tab">
      <div className="cal-bar">
        <div className="cal-left">
          <button type="button" className="sm cal-today" onClick={() => (setCursor(today), setRange({ from: today, to: addDays(today, 13) }))}>
            Today
          </button>
          <button type="button" className="icon-btn sm" title="Previous" aria-label="Previous" onClick={() => step(-1)}>
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="icon-btn sm" title="Next" aria-label="Next" onClick={() => step(1)}>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
          </button>
          {mode === 'agenda' ? (
            <DateRangePicker className="cal-title-range" label="Dates" value={range} onChange={setRange} />
          ) : (
            <h2 className="cal-title">{mode === 'month' ? monthTitle(cursor) : weekTitle(weekStart(cursor, ws), today)}</h2>
          )}
        </div>
        <div className="cal-right">
          <label className="cal-opt">
            <Switch label="Show tasks" checked={showTasks} onChange={setShowTasks} />
            <span className="cal-opt-label">Tasks</span>
          </label>
          <Segmented size="sm" label="View" value={mode} options={VIEWS} onChange={pickMode} />
          <button
            ref={newButton}
            type="button"
            className="primary sm cal-new"
            title="New event"
            onClick={() => {
              const day = mode === 'agenda' ? (range.from <= today && today <= range.to ? today : range.from) : shown.from <= today && today <= shown.to ? today : mode === 'week' ? shown.from : `${cursor.slice(0, 7)}-01`;
              setEditing({ draft: newDraft(day, 9 * 60), anchor: newButton.current! });
            }}
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden />
            <span className="cal-new-label">New event</span>
          </button>
        </div>
      </div>

      <div className={`cal-body${switched ? ' switched' : ''}`}>
        {mode === 'month' && (
          <MonthView
            cursor={cursor}
            today={today}
            events={events}
            tasks={tasks}
            onOpen={open}
            onNew={(day, el) => setEditing({ draft: newDraft(day, 9 * 60), anchor: el })}
            onToggle={toggleTask}
            onMore={(day) => (setRange({ from: day, to: day }), pickMode('agenda'))}
          />
        )}
        {mode === 'week' && (
          <WeekView
            cursor={cursor}
            today={today}
            events={events}
            tasks={tasks}
            draft={weekDraft}
            onOpen={open}
            onCreate={onCreate}
            onChange={(e, day, start, end) =>
              void glossly.invoke('calendar:update', { id: e.id, patch: { starts_at: joinStamp(day, toClock(start)), ends_at: joinStamp(day, toClock(Math.min(end, DAY_MIN - 1))) } })
            }
            onToggle={toggleTask}
          />
        )}
        {mode === 'agenda' && <AgendaView range={range} today={today} events={events} tasks={tasks} onOpen={open} onToggle={toggleTask} />}
      </div>

      {editing && <EventEditor key={`${editing.draft.id}:${editing.draft.day}:${editing.draft.start}`} anchor={editing.anchor} draft={editing.draft} onClose={closeEditor} />}
    </section>
  );
}
