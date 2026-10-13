import type { UpdateView } from '@glossly/core/api';
import { timeAgo } from './format';

/** What Settings > General says about updating, and the one button it offers (decision 70). */
export interface UpdateLine {
  text: string;
  /** null: no button (dev build, or a download running). */
  button: { label: string; action: 'check' | 'download' | 'install'; primary: boolean; disabled: boolean } | null;
}

export function updateLine(v: UpdateView, now = Date.now()): UpdateLine {
  const check = (disabled = false) => ({ label: 'Check for updates', action: 'check' as const, primary: false, disabled });
  const s = v.state;
  switch (s.status) {
    case 'unsupported':
      return { text: 'Updates come with the installed app.', button: null };
    case 'idle':
      return { text: 'Glossly checks for updates on its own.', button: check() };
    case 'checking':
      return { text: 'Checking for updates…', button: check(true) };
    case 'none':
      return { text: `You're up to date. Checked ${timeAgo(s.checkedAt, now)}.`, button: check() };
    case 'available':
      return { text: `Version ${s.version} is available.`, button: { label: 'Download', action: 'download', primary: true, disabled: false } };
    case 'downloading':
      return { text: `Downloading version ${s.version}… ${s.percent}%`, button: null };
    case 'ready':
      return { text: `Version ${s.version} is ready to install.`, button: { label: 'Restart to update', action: 'install', primary: true, disabled: false } };
    case 'error':
      return { text: s.kind === 'offline' ? "Couldn't check for updates: you're offline." : "Couldn't check for updates.", button: { ...check(), label: 'Try again' } };
  }
}
