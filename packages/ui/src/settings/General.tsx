import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AppMode, Settings, SettingsKey, SettingsView } from '@glossly/core/api';
import { X } from 'lucide-react';
import { glossly } from '../bridge';
import { Select } from '../controls/Select';
import { ChoiceCards, Segmented, Switch } from '../controls/Toggles';
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

/** Shows a shortcut and records a new one: hold Ctrl, Alt, or Win and press a key. */
function ShortcutRecorder({ value, fallback, busy, onSet }: { value: string; fallback: string; busy: boolean; onSet: (accelerator: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

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
    onSet(r.accelerator);
  };

  return (
    <>
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
          <kbd className="hotkey">{formatAccelerator(value)}</kbd>
        )}
        <button disabled={busy || recording} onClick={() => setRecording(true)}>
          Change
        </button>
        {value !== fallback && (
          <button disabled={busy} onClick={() => onSet(fallback)}>
            Reset
          </button>
        )}
      </div>
      {recording && <p className="muted small">{hint ?? 'Hold Ctrl, Alt, or Win and press a key. Esc cancels.'}</p>}
    </>
  );
}

function Hotkey({ view }: { view: SettingsView }) {
  const { busy, error, setError, set } = useSetting();
  return (
    <div className="field">
      <div className="field-label">
        <strong>Hotkey</strong>
        <p className="muted small">Opens the bar for the current selection, in any app. With nothing selected, it opens search.</p>
      </div>
      <ShortcutRecorder
        value={view.settings.hotkey}
        fallback="Control+Alt+Space"
        busy={busy}
        onSet={(acc) => {
          setError(null);
          void set('hotkey', acc);
        }}
      />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

const SAVE_MODES: { mode: Settings['saveMode']; label: string; desc: string }[] = [
  { mode: 'manual', label: 'Manual', desc: 'The bar shows Save to the collection Glossly picks. Click it to choose and save.' },
  { mode: 'hotkey', label: 'Manual, plus a save hotkey', desc: 'Save stays in the bar, and a second shortcut saves the selection straight away, with Undo.' },
  { mode: 'autosave', label: 'Autosave on highlight', desc: 'Every highlight that shows the pill is saved as you make it. The bar offers Undo instead of Save.' },
];

/** Save mode (decision 15), next to the main hotkey. */
function SaveMode({ view }: { view: SettingsView }) {
  const { busy, error, setError, set } = useSetting();
  const mode = view.settings.saveMode;
  return (
    <div className="field">
      <div className="field-label">
        <strong>Saving</strong>
        <p className="muted small">Every save goes to the collection Glossly picks for the selection, and can be undone for {view.settings.save.undoSeconds} seconds.</p>
      </div>
      <ChoiceCards
        className="stacked"
        label="Save mode"
        value={mode}
        disabled={busy}
        options={SAVE_MODES.map((m) => ({ value: m.mode, title: m.label, desc: m.desc }))}
        onChange={(m) => {
          setError(null);
          void set('saveMode', m);
        }}
      />
      {mode === 'hotkey' && (
        <ShortcutRecorder
          value={view.settings.saveHotkey}
          fallback="Control+Alt+S"
          busy={busy}
          onSet={(acc) => {
            setError(null);
            void set('saveHotkey', acc);
          }}
        />
      )}
      {mode === 'autosave' && <p className="muted small">Passwords and empty selections are never saved, and the same text is not saved twice while it stays selected.</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function Toggle({ view, k, label, desc }: { view: SettingsView; k: 'debugView'; label: string; desc: string }) {
  const { busy, error, set } = useSetting();
  return (
    <div className="field">
      <div className="toggle">
        <span>
          <strong>{label}</strong>
          <span className="muted small block">{desc}</span>
        </span>
        <Switch label={label} checked={view.settings[k]} disabled={busy} onChange={(on) => void set(k, on)} />
      </div>
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
      <input className="grow" placeholder="An app or site, such as Slack or Google Docs" value={value} onChange={(e) => setValue(e.target.value)} />
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
    <Select size="sm" label={label} value={value} disabled={busy} onChange={onChange} options={(Object.keys(MODE_LABELS) as AppMode[]).map((m) => ({ value: m, label: MODE_LABELS[m] }))} />
  );
  return (
    <div className="field">
      <div className="field-label">
        <strong>Per-app behavior</strong>
        <p className="muted small">
          Auto pill shows the pill when you select text. Hotkey only waits for the hotkey. Off ignores the app, even on the hotkey. Name an app or a
          site, such as Slack, Discord, or Google Docs: a name covers the app and the site in a browser. A process name such as slack.exe covers
          only the app.
        </p>
      </div>
      {entries.length > 0 && (
        <ul className="list">
          {entries.map(([key, m]) => (
            <li key={key}>
              <code className="grow">{key}</code>
              {modeSelect(m, (next) => update({ ...modes, [key]: next }), `Mode for ${key}`)}
              <button
                className="icon-btn sm"
                title={`Remove ${key}`}
                disabled={busy}
                onClick={() => {
                  const next = { ...modes };
                  delete next[key];
                  update(next);
                }}
              >
                <X size={14} strokeWidth={1.75} aria-hidden />
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

/** Apps Glossly never reads from (shown in Privacy and data). */
export function BlockList({ view }: { view: SettingsView }) {
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
              <button className="icon-btn sm" title={`Remove ${key}`} disabled={busy} onClick={() => void set('blockList', list.filter((k) => k !== key))}>
                <X size={14} strokeWidth={1.75} aria-hidden />
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

/** When the bar shows its keys (decision 41). */
function KeyHintsField({ view }: { view: SettingsView }) {
  const { busy, error, set } = useSetting();
  const v = view.settings.keyHints;
  return (
    <div className="field">
      <div className="toggle">
        <span>
          <strong>Show keyboard shortcuts</strong>
          <span className="muted small block">
            {v === 'always' ? 'Every bar shows its keys.' : v === 'hotkey' ? 'A bar opened with the hotkey shows its keys.' : 'No key chips.'} The keys work whenever the bar has focus.
          </span>
        </span>
        <Segmented
          size="sm"
          label="Show keyboard shortcuts"
          disabled={busy}
          value={v}
          options={[
            ['always', 'Always'],
            ['hotkey', 'On hotkey'],
            ['never', 'Never'],
          ]}
          onChange={(next) => void set('keyHints', next)}
        />
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The calendar and date pickers start weeks on Monday (the default) or Sunday. */
function WeekStartField({ view }: { view: SettingsView }) {
  const { busy, error, set } = useSetting();
  return (
    <div className="field">
      <div className="toggle">
        <span>
          <strong>Week starts on</strong>
          <span className="muted small block">For the Calendar tab and every date picker.</span>
        </span>
        <Segmented
          size="sm"
          label="Week starts on"
          disabled={busy}
          value={String(view.settings.weekStart) as '0' | '1'}
          options={[
            ['1', 'Monday'],
            ['0', 'Sunday'],
          ]}
          onChange={(v) => void set('weekStart', Number(v))}
        />
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function GeneralTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>General</h2>
      <p className="muted">How Glossly opens, saves, and shows dates.</p>
      <Hotkey view={view} />
      <KeyHintsField view={view} />
      <SaveMode view={view} />
      <AppModes view={view} />
      <WeekStartField view={view} />
      <Toggle view={view} k="debugView" label="Debug view" desc="Shows capture method, timings, and routing details at the bottom of the bar." />
    </section>
  );
}
