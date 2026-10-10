// The settings window: first-run setup (#setup) and the settings tabs (#keys, #models,
// #general, #data, #metrics). Main changes the hash on an open window to switch tabs.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
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
        <div className="brand">Glossly</div>
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} className={t.id === tab ? 'current' : undefined} aria-current={t.id === tab ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
        <span className="spacer" />
        {!view.settings.firstRunComplete && (
          <a href="#setup" className="setup-link">
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
