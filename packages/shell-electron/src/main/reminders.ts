import { Notification } from 'electron';
import { eventReminderText, isoNow, reminderCutoff, reminderText } from '@glossly/core';
import { errorInfo, logger } from './log';
import type { Services } from './services';

const log = logger('reminders');
const CHECK_MS = 60_000;
/** A launch after days away shows at most this many at once; the rest follow a minute later. */
const MAX_PER_CHECK = 3;

/**
 * Due-date notifications for saved commitments (spec: on the due date at 9:00 local time), and
 * reminders before calendar events (decision 37: `eventReminderMinutes` before a timed one, the
 * reminder hour for an all-day one). Each shows once (`notified_at`). Clicking one opens
 * Settings > Agenda.
 */
export class Reminders {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Shown notifications, kept so their click handlers survive garbage collection. */
  private readonly live = new Set<Notification>();

  constructor(
    private readonly services: Services,
    private readonly openAgenda: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    if (!Notification.isSupported()) {
      log.warn('notifications not supported');
      return;
    }
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private notify(title: string, body: string): void {
    const n = new Notification({ title, body });
    this.live.add(n);
    n.on('click', () => {
      this.openAgenda();
      this.live.delete(n);
    });
    n.on('close', () => this.live.delete(n));
    n.show();
  }

  check(now = new Date()): void {
    try {
      const { people, calendar, settings } = this.services;
      const cutoff = reminderCutoff(now, settings.reminderHour);
      const events = calendar.dueReminders(now, settings.eventReminderMinutes, cutoff);
      for (const e of events.slice(0, MAX_PER_CHECK)) {
        const { title, body } = eventReminderText(e);
        this.notify(title, body);
        calendar.markNotified(e.id);
        log.info('event reminder shown', { all_day: e.all_day });
      }
      const due = people.dueUnnotified(cutoff);
      for (const c of due.slice(0, Math.max(0, MAX_PER_CHECK - events.length))) {
        const { title, body } = reminderText(c, now);
        this.notify(title, body);
        people.markNotified(c.id);
        log.info('reminder shown', { owner: c.owner, overdue: (c.due_at ?? '').slice(0, 10) < isoNow(now).slice(0, 10) });
      }
    } catch (e) {
      log.error('reminder check failed', errorInfo(e));
    }
  }
}
