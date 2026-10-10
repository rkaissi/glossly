import { Notification } from 'electron';
import { isoNow, reminderCutoff, reminderText } from '@glossly/core';
import { errorInfo, logger } from './log';
import type { Services } from './services';

const log = logger('reminders');
const CHECK_MS = 60_000;
/** A launch after days away shows at most this many at once; the rest follow a minute later. */
const MAX_PER_CHECK = 3;

/**
 * Due-date notifications for saved commitments (spec: on the due date at 9:00 local time).
 * Each shows once (commitments.notified_at). Clicking one opens Settings > People, where the
 * commitment can be marked done.
 */
export class Reminders {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Shown notifications, kept so their click handlers survive garbage collection. */
  private readonly live = new Set<Notification>();

  constructor(
    private readonly services: Services,
    private readonly openPeople: () => void,
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

  check(now = new Date()): void {
    try {
      const people = this.services.people;
      const due = people.dueUnnotified(reminderCutoff(now, this.services.settings.reminderHour));
      for (const c of due.slice(0, MAX_PER_CHECK)) {
        const { title, body } = reminderText(c, now);
        const n = new Notification({ title, body });
        this.live.add(n);
        n.on('click', () => {
          this.openPeople();
          this.live.delete(n);
        });
        n.on('close', () => this.live.delete(n));
        n.show();
        people.markNotified(c.id);
        log.info('reminder shown', { owner: c.owner, overdue: (c.due_at ?? '').slice(0, 10) < isoNow(now).slice(0, 10) });
      }
    } catch (e) {
      log.error('reminder check failed', errorInfo(e));
    }
  }
}
