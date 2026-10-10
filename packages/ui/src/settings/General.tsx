import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AppMode, SettingsKey, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { formatAccelerator, normalizeAppKey, toAccelerator } from './format';
import { useAction } from './useAction';

const MODE_LABELS: Record<AppMode, string> = { auto: 'Auto pill', hotkey: 'Hotkey only', off: 'Off' };

function useSetting() {
  const a = useAction();
  const set = (key: SettingsKey, value: unknown) =>
    a.run(async () => {
      const r = await glossly.invoke('settings:set', { key, value });
      if (r.error) throw new Error(r.error);
      return r;
    });
  return { ...a, set };
}

function Hotkey({ view }: { view: SettingsView }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const { busy, error, setError, set } = useSetting();

  const onKeyDown = (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      setRecording(false);
      setHint(null);
      return;
    }
    const r = toAccelerator({ key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    if ('pending' in r) return;
    if ('error' in r) {
      setHint(r.error);
      return;
    }
    setRecording(false);
    setHint(null);
    void set('hotkey', r.accelerator);
  };

  return (
    <div className="field">
      <div className="field-label">
        <strong>Hotkey</strong>
        <p className="muted small">Opens the bar for the current selection, in any app. It is the only keyboard shortcut Glossly listens for.</p>
      </div>
      <div className="row">
        {recording ? (
          <input
            className="hotkey-input"
            autoFocus
            readOnly
            value="Press the new shortcut…"
            aria-label="Press the new shortcut"
            onKeyDown={onKeyDown}
            onBlur={() => setRecording(false)}
          />
        ) : (
          <kbd className="hotkey">{formatAccelerator(view.settings.hotkey)}</kbd>
        )}
        <button
          disabled={busy || recording}
          onClick={() => {
            setError(null);
            setRecording(true);
          }}
        >
          Change
        </button>
        {view.settings.hotkey !== 'Control+Alt+Space' && (
          <button disabled={busy} onClick={() => void set('hotkey', 'Control+Alt+Space')}>
            Reset
          </button>
        )}
      </div>
      {recording && <p className="muted small">{hint ?? 'Hold Ctrl, Alt, or Win and press a key. Esc cancels.'}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function Toggle({ view, k, label, desc }: { view: SettingsView; k: 'localOnly' | 'debugView'; label: string; desc: string }) {
  const { busy, error, set } = useSetting();
  return (
    <div className="field">
      <label className="toggle">
        <input type="checkbox" checked={view.settings[k]} disabled={busy} onChange={(e) => void set(k, e.target.checked)} />
        <span>
          <strong>{label}</strong>
          <span className="muted small block">{desc}</span>
        </span>
      </label>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function AddAppKey({ onAdd, children, busy }: { onAdd: (key: string) => void; children?: ReactNode; busy: boolean }) {
  const [value, setValue] = useState('');
  const key = normalizeAppKey(value);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!key) return;
        onAdd(key);
        setValue('');
      }}
    >
      <input className="grow" placeholder='slack.exe, or "- Google Docs" for a site' value={value} onChange={(e) => setValue(e.target.value)} />
      {children}
      <button type="submit" disabled={busy || !key}>
        Add{key && key !== value.trim() ? ` ${key}` : ''}
      </button>
    </form>
  );
}

function AppModes({ view }: { view: SettingsView }) {
  const { busy, error, set } = useSetting();
  const [mode, setMode] = useState<AppMode>('hotkey');
  const modes = view.settings.appModes;
  const entries = Object.entries(modes).sort(([a], [b]) => a.localeCompare(b));
  const update = (next: Record<string, AppMode>) => void set('appModes', next);
  const modeSelect = (value: AppMode, onChange: (m: AppMode) => void, label: string) => (
    <select value={value} aria-label={label} disabled={busy} onChange={(e) => onChange(e.target.value as AppMode)}>
      {(Object.keys(MODE_LABELS) as AppMode[]).map((m) => (
        <option key={m} value={m}>
          {MODE_LABELS[m]}
        </option>
      ))}
    </select>
  );
  return (
    <div className="field">
      <div className="field-label">
        <strong>Per-app behavior</strong>
        <p className="muted small">
          Auto pill shows the pill when you select text. Hotkey only waits for the hotkey. Off ignores the app, even on the hotkey. Keys are a process
          name, or a window-title ending such as "- Google Docs" for one site in a browser.
        </p>
      </div>
      {entries.length > 0 && (
        <ul className="list">
          {entries.map(([key, m]) => (
            <li key={key}>
              <code className="grow">{key}</code>
              {modeSelect(m, (next) => update({ ...modes, [key]: next }), `Mode for ${key}`)}
              <button
                className="icon-btn"
                title={`Remove ${key}`}
                disabled={busy}
                onClick={() => {
                  const next = { ...modes };
                  delete next[key];
                  update(next);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddAppKey busy={busy} onAdd={(key) => update({ ...modes, [key]: mode })}>
        {modeSelect(mode, setMode, 'Mode for the new app')}
      </AddAppKey>
      <p className="muted small">Hotkey only by default: {view.builtins.hotkeyOnly.join(', ')}.</p>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function BlockList({ view }: { view: SettingsView }) {
  const { busy, error, set } = useSetting();
  const list = view.settings.blockList;
  return (
    <div className="field">
      <div className="field-label">
        <strong>Block list</strong>
        <p className="muted small">Glossly never reads from these apps, on any trigger.</p>
      </div>
      {list.length > 0 && (
        <ul className="list">
          {list.map((key) => (
            <li key={key}>
              <code className="grow">{key}</code>
              <button className="icon-btn" title={`Remove ${key}`} disabled={busy} onClick={() => void set('blockList', list.filter((k) => k !== key))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddAppKey busy={busy} onAdd={(key) => !list.includes(key) && void set('blockList', [...list, key])} />
      <details className="small">
        <summary className="muted">Always blocked ({view.builtins.blockList.length} password managers and vaults)</summary>
        <p className="muted">{view.builtins.blockList.join(', ')}</p>
      </details>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function GeneralTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>General</h2>
      <Hotkey view={view} />
      <Toggle
        view={view}
        k="localOnly"
        label="Local only"
        desc="The router never calls a model; slots 3 and 4 come from local rules. Ask and Save still use your models when you click them."
      />
      <Toggle view={view} k="debugView" label="Debug view" desc="Shows capture method, timings, and routing details at the bottom of the bar." />
      <AppModes view={view} />
      <BlockList view={view} />
    </section>
  );
}
