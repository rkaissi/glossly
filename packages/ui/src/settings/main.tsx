// The settings window: first-run setup (#setup) and the tabs, in two groups (Step 20.1): what you
// keep (#tasks, #calendar, #people, #saved) and the settings (#profile, #models, #privacy, #general, #metrics).
// Main changes the hash on an open window to switch tabs. #keys, #data, and #agenda are older names.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Bookmark, CalendarDays, CircleCheck, Cpu, Shield, SlidersHorizontal, Sparkles, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import type { SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { GlosslyMark } from '../icons';
import '../theme.css';
import '../controls/controls.css';
import './settings.css';
import { PrivacyDataTab } from './Data';
import { GeneralTab } from './General';
import { MetricsTab } from './Metrics';
import { ModelsTab } from './Models';
import { PeopleTab } from './People';
import { ProfileTab } from './Profile';
import { SavedTab } from './Saved';
import { Setup } from './Setup';
import { CalendarTab } from './Calendar';
import { TasksTab } from './Tasks';
import { useLive } from './useLive';
import { WeekStartContext } from '../controls/week';
import { toDay } from '../controls/logic';

const TABS = [
  { id: 'tasks', label: 'Tasks', group: 'mine' },
  { id: 'calendar', label: 'Calendar', group: 'mine' },
  { id: 'people', label: 'People', group: 'mine' },
  { id: 'saved', label: 'Saved', group: 'mine' },
  { id: 'profile', label: 'Profile', group: 'settings' },
  { id: 'models', label: 'Models', group: 'settings' },
  { id: 'privacy', label: 'Privacy', group: 'settings' },
  { id: 'general', label: 'General', group: 'settings' },
  { id: 'metrics', label: 'Metrics', group: 'settings' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const TAB_ICONS: Record<Tab, LucideIcon> = { tasks: CircleCheck, calendar: CalendarDays, people: UsersRound, saved: Bookmark, profile: UserRound, models: Cpu, privacy: Shield, general: SlidersHorizontal, metrics: Activity };

/** Tabs that moved: Keys is part of Models and Data of Privacy (Step 20.1); Agenda became Tasks and Calendar (Step 20.2). */
const MOVED: Record<string, Tab> = { keys: 'models', data: 'privacy', agenda: 'tasks' };

/** Open tasks due today or earlier, beside Tasks in the sidebar. */
function DueCount() {
  const open = useLive(useCallback(() => glossly.invoke('commitments:list', { status: 'open' }), []));
  const today = toDay(new Date());
  const n = (open ?? []).filter((t) => t.due_at && t.due_at.slice(0, 10) <= today).length;
  return n > 0 ? <span className="nav-count">{n}</span> : null;
}

// Main loads the page with ?material=mica when the window is Windows 11 mica.
document.documentElement.dataset.material = new URLSearchParams(location.search).get('material') ?? 'none';

const isTab = (h: string): h is Tab => TABS.some((t) => t.id === h);
const readHash = () => {
  const h = location.hash.replace(/^#/, '');
  return MOVED[h] ?? h;
};
/** "#people/<id>" is the People tab showing one person's record. */
const splitHash = (h: string): [string, string | null] => {
  const [head, rest] = h.split(/\/(.*)/s);
  return [head ?? '', rest ? decodeURIComponent(rest) : null];
};

function App() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [hash, setHash] = useState(readHash);
  // Tabs switched within 400 ms of the last switch appear without the page animation (decision 45).
  const [quick, setQuick] = useState(false);
  const lastSwitch = useRef(0);

  useEffect(() => {
    let pushed = false;
    const offView = glossly.on('settings:changed', (v) => {
      pushed = true;
      setView(v);
    });
    const offEmbed = glossly.on('embed:progress', (embed) => setView((v) => v && { ...v, embed }));
    void glossly.invoke('settings:get').then((v) => !pushed && setView(v));
    const onHash = () => {
      const now = performance.now();
      setQuick(now - lastSwitch.current < 400);
      lastSwitch.current = now;
      setHash(readHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      offView();
      offEmbed();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  if (!view) return <div className="loading muted">Loading…</div>;

  // Until setup is finished, a window opened without a tab shows setup.
  const [head, personId] = splitHash(hash);
  if (head === 'setup' || (!isTab(head) && !view.settings.firstRunComplete)) {
    return <Setup view={view} onDone={() => (location.hash = 'tasks')} />;
  }
  const tab: Tab = isTab(head) ? head : 'tasks';
  return (
    <WeekStartContext.Provider value={view.settings.weekStart}>
      <div className="settings">
        <nav>
          <div className="brand">
            <GlosslyMark size={18} />
            Glossly
          </div>
          {TABS.map((t, i) => {
            const Icon = TAB_ICONS[t.id];
            return (
              <Fragment key={t.id}>
                {t.group !== TABS[i - 1]?.group && t.group === 'settings' && <div className="nav-group">Settings</div>}
                <a href={`#${t.id}`} className={t.id === tab ? 'current' : undefined} aria-current={t.id === tab ? 'page' : undefined}>
                  <Icon size={16} strokeWidth={1.75} aria-hidden />
                  {t.label}
                  {t.id === 'tasks' && <DueCount />}
                </a>
              </Fragment>
            );
          })}
          <span className="spacer" />
          {!view.settings.firstRunComplete && (
            <a href="#setup" className="setup-link">
              <Sparkles size={16} strokeWidth={1.75} aria-hidden />
              Finish setup
            </a>
          )}
          {view.settings.firstRunComplete && !view.settings.identity.name.trim() && tab !== 'profile' && (
            <a href="#profile" className="setup-link">
              <UserRound size={16} strokeWidth={1.75} aria-hidden />
              Add your name
            </a>
          )}
        </nav>
        <main className={quick ? 'quick' : undefined}>
          {tab === 'profile' && <ProfileTab view={view} />}
          {tab === 'people' && <PeopleTab personId={personId} />}
          {tab === 'tasks' && <TasksTab />}
          {tab === 'calendar' && <CalendarTab view={view} />}
          {tab === 'saved' && <SavedTab />}
          {tab === 'models' && <ModelsTab view={view} />}
          {tab === 'general' && <GeneralTab view={view} />}
          {tab === 'privacy' && <PrivacyDataTab view={view} />}
          {tab === 'metrics' && <MetricsTab />}
        </main>
      </div>
    </WeekStartContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
