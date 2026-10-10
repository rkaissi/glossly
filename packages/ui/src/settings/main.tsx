// Placeholder settings window for the shell milestone. Step 4 replaces it with first-run
// setup and the settings tabs.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';

function Settings() {
  const [view, setView] = useState<SettingsView | null>(null);
  useEffect(() => {
    void glossly.invoke('settings:get').then(setView);
    return glossly.on('settings:changed', setView);
  }, []);
  return (
    <div style={{ font: '13px system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18 }}>Glossly settings</h1>
      <p>The settings UI arrives in step 4. Current state:</p>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{view ? JSON.stringify({ ...view, models: `${view.models.length} models` }, null, 2) : 'Loading…'}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Settings />);
