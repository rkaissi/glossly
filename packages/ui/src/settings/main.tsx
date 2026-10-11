// The settings window: first-run setup (#setup) and the tabs, in two groups (Step 20.1): what you
// keep (#agenda, #people, #saved) and the settings (#profile, #models, #privacy, #general, #metrics).
// Main changes the hash on an open window to switch tabs. #keys and #data are older names.
import { Fragment, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Bookmark, CalendarCheck, Cpu, Shield, SlidersHorizontal, Sparkles, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
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
import { AgendaTab } from './Agenda';

const TABS = [
  { id: 'agenda', label: 'Agenda', group: 'mine' },
  { id: 'people', label: 'People', group: 'mine' },
  { id: 'saved', label: 'Saved', group: 'mine' },
  { id: 'profile', label: 'Profile', group: 'settings' },
  { id: 'models', label: 'Models', group: 'settings' },
  { id: 'privacy', label: 'Privacy and data', group: 'settings' },
  { id: 'general', label: 'General', group: 'settings' },
  { id: 'metrics', label: 'Metrics', group: 'settings' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const TAB_ICONS: Record<Tab, LucideIcon> = { agenda: CalendarCheck, people: UsersRound, saved: Bookmark, profile: UserRound, models: Cpu, privacy: Shield, general: SlidersHorizontal, metrics: Activity };

/** Tabs that moved in Step 20.1: Keys is part of Models, Data of Privacy and data. */
const MOVED: Record<string, Tab> = { keys: 'models', data: 'privacy' };

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

  useEffect(() => {
    let pushed = false;
    const offView = glossly.on('settings:changed', (v) => {
      pushed = true;
      setView(v);
    });
    const offEmbed = glossly.on('embed:progress', (embed) => setView((v) => v && { ...v, embed }));
    void glossly.invoke('settings:get').then((v) => !pushed && setView(v));
    const onHash = () => setHash(readHash());
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
    return <Setup view={view} onDone={() => (location.hash = 'agenda')} />;
  }
  const tab: Tab = isTab(head) ? head : 'agenda';
  return (
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
      <main>
        {tab === 'profile' && <ProfileTab view={view} />}
        {tab === 'people' && <PeopleTab personId={personId} />}
        {tab === 'agenda' && <AgendaTab />}
        {tab === 'saved' && <SavedTab />}
        {tab === 'models' && <ModelsTab view={view} />}
        {tab === 'general' && <GeneralTab view={view} />}
        {tab === 'privacy' && <PrivacyDataTab view={view} />}
        {tab === 'metrics' && <MetricsTab />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
