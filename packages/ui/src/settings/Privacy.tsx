import type { Privacy, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { useAction } from './useAction';

const CHOICES: { value: Privacy; label: string; desc: string }[] = [
  {
    value: 'all',
    label: 'All models',
    desc: 'Glossly uses any provider you set up, cloud or local. Selected text goes to that provider when the bar opens and when you click an action.',
  },
  {
    value: 'local',
    label: 'Local only',
    desc: 'Nothing leaves this computer. Model calls go to your local model (Ollama or LM Studio), and slots 3 and 4 come from local rules.',
  },
];

/** What Local only does right now: the local model it uses, or the rules it falls back to. */
function LocalOnlyStatus({ view, onSetUp }: { view: SettingsView; onSetUp: () => void }) {
  const { baseUrl, loopback } = view.local;
  const model = view.models.find((m) => m.ref === view.settings.local.model);
  if (baseUrl && loopback && model) return <p className="muted small">Using {model.displayName} on this computer for every model call.</p>;
  return (
    <div className="row">
      <p className="warn small grow">
        {baseUrl && !loopback ? 'Your local server is on another computer, so Local only does not use it. ' : 'No local model is set up. '}
        Until one is, Glossly works without a model: Who is this and Tasks read the text with simple patterns, Visualize charts tables in
        code, Save skips finding people, and Ask, Reply, and the paste summary are off.
      </p>
      <button onClick={onSetUp}>Set up a local model</button>
    </div>
  );
}

/** The privacy choice (decision 34), in General and in setup. */
export function PrivacyChoice({ view, onSetUp }: { view: SettingsView; onSetUp: () => void }) {
  const { busy, error, run } = useAction();
  const current = view.settings.privacy;
  const set = (value: Privacy) =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'privacy', value });
      if (r.error) throw new Error(r.error);
    });
  return (
    <div className="field">
      <div className="field-label">
        <strong>Where model calls go</strong>
      </div>
      <div className="choices" role="radiogroup" aria-label="Where model calls go">
        {CHOICES.map((c) => (
          <label key={c.value} className={`choice${current === c.value ? ' selected' : ''}`}>
            <input type="radio" name="privacy" checked={current === c.value} disabled={busy} onChange={() => set(c.value)} />
            <span>
              <strong>{c.label}</strong>
              <span className="muted small block">{c.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {current === 'local' && <LocalOnlyStatus view={view} onSetUp={onSetUp} />}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
