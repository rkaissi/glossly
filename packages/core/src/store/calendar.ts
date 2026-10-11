import { uuidv7 } from 'uuidv7';
import type { CalendarEvent, EventPatch, EventSaveRow } from '../calendar/types';
import { isoNow } from '../types';
import type { Store } from './store';

const MAX_TITLE = 200;
const MAX_LOCATION = 300;
const MAX_ATTENDEES = 20;

interface EventDbRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: number;
  location: string | null;
  attendees: string;
  source_app: string | null;
  created_at: string;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** The local day ("YYYY-MM-DD") an event starts on. */
export const eventDay = (startsAt: string) => startsAt.slice(0, 10);

/**
 * Calendar events (Step 19.2, decision 37), stored on this computer only. Days compare as
 * "YYYY-MM-DD" prefixes of `starts_at`, so all-day and timed events sort together.
 */
export class CalendarRepo {
  constructor(
    private readonly store: Store,
    private readonly now: () => string = isoNow,
  ) {}

  private get db() {
    return this.store.db;
  }

  private toEvent(r: EventDbRow): CalendarEvent {
    let attendees: string[] = [];
    try {
      const parsed = JSON.parse(r.attendees) as unknown;
      if (Array.isArray(parsed)) attendees = parsed.filter((a): a is string => typeof a === 'string');
    } catch {
      /* stored by an older build or edited by hand */
    }
    const people = this.db
      .prepare('SELECT p.id, p.name FROM calendar_event_people ep JOIN people p ON p.id = ep.person_id WHERE ep.event_id = ? ORDER BY p.name')
      .all(r.id) as { id: string; name: string }[];
    return { ...r, all_day: r.all_day === 1, attendees, people };
  }

  add(e: EventSaveRow, sourceApp: string | null): CalendarEvent {
    const title = oneLine(e.title, MAX_TITLE);
    if (!title) throw new Error('An event needs a title.');
    const id = uuidv7();
    this.store.tx(() => {
      this.db
        .prepare(
          'INSERT INTO calendar_events (id, title, starts_at, ends_at, all_day, location, attendees, source_app, created_at, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        )
        .run(
          id,
          title,
          e.starts_at,
          e.all_day ? null : e.ends_at,
          e.all_day ? 1 : 0,
          e.location?.trim() ? oneLine(e.location, MAX_LOCATION) : null,
          JSON.stringify(e.attendees.map((a) => oneLine(a, 100)).filter(Boolean).slice(0, MAX_ATTENDEES)),
          sourceApp,
          this.now(),
        );
      const link = this.db.prepare('INSERT OR IGNORE INTO calendar_event_people (event_id, person_id) SELECT ?, id FROM people WHERE id = ?');
      for (const pid of e.personIds) link.run(id, pid);
    });
    return this.get(id)!;
  }

  get(id: string): CalendarEvent | null {
    const r = this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as EventDbRow | undefined;
    return r ? this.toEvent(r) : null;
  }

  /**
   * Events by start, filtered by day range (inclusive "YYYY-MM-DD"), person, or words in the title,
   * location, or attendees.
   */
  list(filter: { from?: string; to?: string; personId?: string; query?: string; limit?: number; newestFirst?: boolean } = {}): CalendarEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.from) {
      where.push('substr(e.starts_at, 1, 10) >= ?');
      args.push(filter.from);
    }
    if (filter.to) {
      where.push('substr(e.starts_at, 1, 10) <= ?');
      args.push(filter.to);
    }
    if (filter.personId) {
      where.push('EXISTS (SELECT 1 FROM calendar_event_people ep WHERE ep.event_id = e.id AND ep.person_id = ?)');
      args.push(filter.personId);
    }
    if (filter.query?.trim()) {
      where.push("(e.title LIKE ? ESCAPE '\\' OR IFNULL(e.location, '') LIKE ? ESCAPE '\\' OR e.attendees LIKE ? ESCAPE '\\')");
      const like = `%${filter.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like);
    }
    const rows = this.db
      .prepare(
        `SELECT e.* FROM calendar_events e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY e.starts_at ${filter.newestFirst ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .all(...args, filter.limit ?? 500) as unknown as EventDbRow[];
    return rows.map((r) => this.toEvent(r));
  }

  update(id: string, patch: EventPatch): void {
    const cur = this.get(id);
    if (!cur) throw new Error('That event is gone.');
    const next = { ...cur, ...patch };
    const title = oneLine(next.title, MAX_TITLE);
    if (!title) throw new Error('An event needs a title.');
    const moved = next.starts_at !== cur.starts_at;
    this.db
      .prepare(`UPDATE calendar_events SET title = ?, starts_at = ?, ends_at = ?, all_day = ?, location = ?${moved ? ', notified_at = NULL' : ''} WHERE id = ?`)
      .run(title, next.starts_at, next.all_day ? null : next.ends_at, next.all_day ? 1 : 0, next.location?.trim() ? oneLine(next.location, MAX_LOCATION) : null, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  }

  /**
   * Events whose reminder is due and not shown: a timed event from `minutesBefore` before its
   * start until it ends, an all-day event on its day from the reminder hour (`allDayCutoff`, the
   * latest day whose reminder may show, as for tasks).
   */
  dueReminders(now: Date, minutesBefore: number, allDayCutoff: string): CalendarEvent[] {
    const nowIso = isoNow(now);
    const soon = isoNow(new Date(now.getTime() + minutesBefore * 60_000));
    const today = nowIso.slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT * FROM calendar_events WHERE notified_at IS NULL AND (
           (all_day = 0 AND starts_at <= ? AND IFNULL(ends_at, starts_at) >= ?)
           OR (all_day = 1 AND starts_at <= ? AND starts_at >= ?)
         ) ORDER BY starts_at`,
      )
      .all(soon, nowIso, allDayCutoff, today) as unknown as EventDbRow[];
    return rows.map((r) => this.toEvent(r));
  }

  markNotified(id: string): void {
    this.db.prepare('UPDATE calendar_events SET notified_at = ? WHERE id = ?').run(this.now(), id);
  }
}
