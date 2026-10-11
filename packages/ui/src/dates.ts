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
