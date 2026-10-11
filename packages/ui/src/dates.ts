// Pure display helpers shared by the overlay and the settings window (unit-tested).

const DAY = 86_400_000;

/** Local midnight of the date in a "YYYY-MM-DD" or ISO string (the date as written, not converted). */
function dateOf(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const hasTime = (s: string) => /T\d{2}:\d{2}/.test(s);

function timeOf(s: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(s)!;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const h12 = h % 12 || 12;
  return `${h12}${min ? `:${String(min).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Today", "Tomorrow", "Yesterday", "Fri" within the next 6 days, else "Oct 16" (plus the year when not this year). */
export function formatDay(s: string, now = new Date()): string {
  const d = dateOf(s);
  if (!d) return '';
  const diff = Math.round((d.getTime() - startOfDay(now).getTime()) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) };
  return d.toLocaleDateString('en-US', opts);
}

/** A due date for display: "Due Fri 3 PM", "Due today", "Overdue: Oct 2", or "No date". */
export function formatDue(due: string | null, now = new Date()): { label: string; overdue: boolean } {
  if (!due) return { label: 'No date', overdue: false };
  const d = dateOf(due);
  if (!d) return { label: 'No date', overdue: false };
  const overdue = d.getTime() < startOfDay(now).getTime();
  const day = formatDay(due, now);
  const when = hasTime(due) ? `${day} ${timeOf(due)}` : day;
  if (overdue) return { label: `Overdue: ${when}`, overdue };
  return { label: `Due ${when.replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}`, overdue };
}

/** An event's time for display: "Thu 1 PM – 2 PM", "Today 9:30 AM", or "Oct 20 · All day" (decision 37). */
export function formatEventTime(e: { starts_at: string; ends_at: string | null; all_day: boolean }, now = new Date()): string {
  const day = formatDay(e.starts_at, now);
  if (e.all_day || !hasTime(e.starts_at)) return `${day} · All day`;
  const end = e.ends_at && hasTime(e.ends_at) && e.ends_at.slice(0, 10) === e.starts_at.slice(0, 10) ? ` – ${timeOf(e.ends_at)}` : '';
  return `${day} ${timeOf(e.starts_at)}${end}`;
}

/** The "YYYY-MM-DD" day and "HH:MM" time of a stored start or end, for date and time inputs. */
export function splitStamp(s: string | null): { day: string; time: string } {
  if (!s) return { day: '', time: '' };
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(s);
  return { day: m?.[1] ?? '', time: m?.[2] ?? '' };
}

/** A local timestamp with the offset, from date and time inputs; the day alone when there is no time. */
export function joinStamp(day: string, time: string): string {
  if (!time) return day;
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const dt = new Date(y!, mo! - 1, d!, h!, mi!);
  const off = -dt.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  return `${day}T${time}:00${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

/** "slack.exe" as "Slack", "ms-teams.exe" as "Ms-teams". */
export function appName(processName: string | null): string {
  if (!processName) return '';
  const base = processName.replace(/\.exe$/i, '');
  return base ? base[0]!.toUpperCase() + base.slice(1) : '';
}

/** A site or app key as a name: "slack.exe" as "Slack", "- Google Docs" as "Google Docs", "Discord |" as "Discord". */
export function siteLabel(key: string): string {
  if (/\.exe$/i.test(key)) return appName(key);
  return key.replace(/^[-—–|]\s*/, '').replace(/\s*\|$/, '');
}

/** The first word of a name, for "Is this the same Sam?". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
