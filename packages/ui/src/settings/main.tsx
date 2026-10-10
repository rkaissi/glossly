// The settings window: first-run setup (#setup) and the settings tabs (#keys, #models,
// #general, #data, #metrics). Main changes the hash on an open window to switch tabs.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Cpu, Database, KeyRound, SlidersHorizontal, Sparkles, type LucideIcon } from 'lucide-react';
import type { SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { GlosslyMark } from '../icons';
import '../theme.css';
import './settings.css';
import { DataTab } from './Data';
import { GeneralTab } from './General';
import { KeysTab } from './Keys';
import { MetricsTab } from './Metrics';
import { ModelsTab } from './Models';
import { Setup } from './Setup';

const TABS = [
  { id: 'keys', label: 'Keys' },
  { id: 'models', label: 'Models' },
  { id: 'general', label: 'General' },
  { id: 'data', label: 'Data' },
  { id: 'metrics', label: 'Metrics' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const TAB_ICONS: Record<Tab, LucideIcon> = { keys: KeyRound, models: Cpu, general: SlidersHorizontal, data: Database, metrics: Activity };

// Main loads the page with ?material=mica when the window is Windows 11 mica.
document.documentElement.dataset.material = new URLSearchParams(location.search).get('material') ?? 'none';

const isTab = (h: string): h is Tab => TABS.some((t) => t.id === h);
const readHash = () => location.hash.replace(/^#/, '');

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
  if (hash === 'setup' || (!isTab(hash) && !view.settings.firstRunComplete)) {
    return <Setup view={view} onDone={() => (location.hash = 'general')} />;
  }
  const tab: Tab = isTab(hash) ? hash : 'keys';
  return (
    <div className="settings">
      <nav>
        <div className="brand">
          <GlosslyMark size={18} />
          Glossly
        </div>
        {TABS.map((t) => {
          const Icon = TAB_ICONS[t.id];
          return (
            <a key={t.id} href={`#${t.id}`} className={t.id === tab ? 'current' : undefined} aria-current={t.id === tab ? 'page' : undefined}>
              <Icon size={16} strokeWidth={1.75} aria-hidden />
              {t.label}
            </a>
          );
        })}
        <span className="spacer" />
        {!view.settings.firstRunComplete && (
          <a href="#setup" className="setup-link">
            <Sparkles size={16} strokeWidth={1.75} aria-hidden />
            Finish setup
          </a>
        )}
      </nav>
      <main>
        {tab === 'keys' && <KeysTab view={view} />}
        {tab === 'models' && <ModelsTab view={view} />}
        {tab === 'general' && <GeneralTab view={view} />}
        {tab === 'data' && <DataTab view={view} />}
        {tab === 'metrics' && <MetricsTab />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
