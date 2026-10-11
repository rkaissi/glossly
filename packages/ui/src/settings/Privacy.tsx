import type { Privacy, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { ChoiceCards } from '../controls/Toggles';
import { canBackfill } from './format';
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

/**
 * Items saved while no model could look for their people and places (decision 44), offered once
 * one can: one Fast call each, so it waits for a click.
 */
function EntityBackfill({ view }: { view: SettingsView }) {
  const { busy, error, setError, run } = useAction();
  const n = view.entitiesPending;
  if (n === 0 || !canBackfill(view)) return error ? <p className="error small">{error}</p> : null;
  const go = () =>
    void run(async () => {
      const r = await glossly.invoke('entities:backfill');
      if (r.error) setError(r.done ? `Found them for ${r.done}, then stopped: ${r.error}` : r.error);
    });
  return (
    <div className="row">
      <p className="muted small grow">
        {n} saved item{n === 1 ? '' : 's'} from before a model was set up {n === 1 ? 'has' : 'have'} no people or places linked. Finding them takes one model call
        each.
      </p>
      <button disabled={busy} onClick={go}>
        {busy ? 'Finding…' : 'Find them'}
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The privacy choice (decision 34), in Privacy and data. */
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
      <ChoiceCards label="Where model calls go" value={current} disabled={busy} onChange={set} options={CHOICES.map((c) => ({ value: c.value, title: c.label, desc: c.desc }))} />
      {current === 'local' && <LocalOnlyStatus view={view} onSetUp={onSetUp} />}
      <EntityBackfill view={view} />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
