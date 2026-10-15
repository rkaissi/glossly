import { useState } from 'react';
import type { Privacy, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { ChoiceCards, Switch } from '../controls/Toggles';
import { canBackfill } from './format';
import { useAction } from './useAction';

const CHOICES: { value: Privacy; label: string; desc: string }[] = [
  {
    value: 'all',
    label: 'All models',
    desc: 'Use any provider you set up. The text you select is sent to it when you use Glossly.',
  },
  {
    value: 'local',
    label: 'Local only',
    desc: 'Nothing leaves this computer. Glossly uses your local model, or works without one.',
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
        Until one is, Ask and Reply are off and the other actions work in a simpler way.
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
        {n} saved item{n === 1 ? '' : 's'} from before a model was set up {n === 1 ? 'has' : 'have'} no people or places linked yet.
      </p>
      <button disabled={busy} onClick={go}>
        {busy ? 'Finding…' : 'Find them'}
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The privacy choice (decision 34), in Privacy. */
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

/**
 * Whether Ask and Reply send the saved notes, people, tasks, and events closest to the question
 * or message along with it (decision 77). On by default; under Local only it stays on this computer anyway.
 */
export function SavedInAnswers({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const ctx = view.settings.context;
  const set = (enabled: boolean) =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'context', value: { ...ctx, enabled } });
      if (r.error) throw new Error(r.error);
    });
  return (
    <div className="field">
      <div className="toggle">
        <span>
          <strong>Use what you've saved in answers</strong>
          <span className="muted small block">
            Ask and Reply get the notes, people, tasks, and events closest to the question or message, so they can answer things like "are you free Thursday?". They go to the model with it, and each answer lists what it used.
          </span>
        </span>
        <Switch label="Use what you've saved in answers" checked={ctx.enabled} disabled={busy} onChange={set} />
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/**
 * The model call log (decision 61): every call's prompt (with the selected text), answer, model,
 * and timing, kept 30 days in the local database to see what the models saw. Turning it off
 * deletes it, so that asks first.
 */
export function CallLog({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const on = view.settings.callLog;
  const set = (value: boolean) =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'callLog', value });
      if (r.error) throw new Error(r.error);
      setConfirming(false);
    });
  return (
    <div className="field">
      <div className="toggle">
        <span>
          <strong>Keep a log of model calls</strong>
          <span className="muted small block">Saves what each model call sent and got back, for 30 days, to help find out why an answer was wrong.</span>
        </span>
        <Switch label="Keep a log of model calls" checked={on && !confirming} disabled={busy} onChange={(v) => (v ? set(true) : setConfirming(true))} />
      </div>
      {confirming && (
        <InlineConfirm prompt="Turning this off deletes the log." confirm="Turn off and delete" busy={busy} onConfirm={() => set(false)} onCancel={() => setConfirming(false)} />
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
