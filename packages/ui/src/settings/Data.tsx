import { useState } from 'react';
import type { EmbedStatus, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { pct } from './format';
import { BlockList } from './General';
import { PrivacyChoice } from './Privacy';
import { useAction } from './useAction';

const EMBED_STATE: Record<EmbedStatus['state'], string> = {
  not_downloaded: 'Not downloaded',
  downloading: 'Downloading',
  loading: 'Loading',
  ready: 'Ready',
  error: 'Failed',
};

export function EmbedLine({ embed }: { embed: EmbedStatus }) {
  const progress = embed.state === 'downloading' && embed.progress !== undefined ? ` ${pct(embed.progress / 100)}` : '';
  return (
    <span className={embed.state === 'error' ? 'error' : embed.state === 'ready' ? 'ok' : undefined}>
      {EMBED_STATE[embed.state]}
      {progress}
      {embed.state === 'error' && embed.message ? `: ${embed.message}` : ''}
    </span>
  );
}

/** The local embedding model (shown in Models). */
export function Embeddings({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const e = view.embed;
  const canStart = e.state === 'not_downloaded' || e.state === 'error';
  return (
    <div className="field">
      <div className="field-label">
        <strong>Local embeddings</strong>
        <p className="muted small">
          {e.model} ({e.dims} dimensions), about 23 MB, runs on this computer. Saved items are embedded so related notes can be found later.
        </p>
      </div>
      <div className="row">
        <EmbedLine embed={e} />
        {e.pending > 0 && (
          <span className="muted small">
            {e.pending} saved item{e.pending === 1 ? '' : 's'} waiting
          </span>
        )}
        <span className="spacer" />
        {canStart && (
          <button disabled={busy} onClick={() => void run(() => glossly.invoke('embed:download'))}>
            {e.state === 'error' ? 'Try again' : 'Download'}
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function Export() {
  const { busy, error, run } = useAction();
  const [path, setPath] = useState<string | null>(null);
  const go = async () => {
    const r = await run(() => glossly.invoke('data:export'));
    if (r) setPath(r.path);
  };
  return (
    <div className="field">
      <div className="field-label">
        <strong>Export</strong>
        <p className="muted small">Everything Glossly stores, as one JSON file: saved items, collections, people, settings, and usage metrics. Keys are not included.</p>
      </div>
      <div className="row">
        <button disabled={busy} onClick={() => void go()}>
          Export to a file…
        </button>
        {path && <span className="ok small">Saved to {path}</span>}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** A destructive button behind an inline confirm. */
function Destructive(props: {
  title: string;
  description: string;
  warning: string;
  button: string;
  confirm: string;
  done: string;
  invoke: () => Promise<void>;
  after?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const go = async () => {
    const ok = await run(async () => {
      await props.invoke();
      return true;
    });
    if (ok) {
      setConfirming(false);
      setDone(true);
      props.after?.();
    }
  };
  return (
    <div className="field">
      <div className="field-label">
        <strong>{props.title}</strong>
        <p className="muted small">{props.description}</p>
      </div>
      {confirming ? (
        <div className="confirm">
          <span>{props.warning}</span>
          <span className="spacer" />
          <button onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
          <button className="danger" onClick={() => void go()} disabled={busy}>
            {props.confirm}
          </button>
        </div>
      ) : (
        <div className="row">
          <button
            className="danger"
            onClick={() => {
              setDone(false);
              setConfirming(true);
            }}
          >
            {props.button}
          </button>
          {done && <span className="ok small">{props.done}</span>}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function DeleteAll() {
  return (
    <Destructive
      title="Delete all data"
      description="Removes saved items, collections, people, and usage metrics from this computer. Your API keys, settings, model list, and the embedding model stay."
      warning="This cannot be undone. Export first if you want a copy."
      button="Delete all data…"
      confirm="Delete all data"
      done="All saved data was deleted."
      invoke={() => glossly.invoke('data:delete-all')}
    />
  );
}

function ResetSettings() {
  return (
    <Destructive
      title="Reset settings"
      description="Removes your saved API keys and puts every setting back to its default, including the hotkey, models, and per-app choices. Saved items stay. Setup starts again afterwards."
      warning="You will need to add a key again."
      button="Reset settings…"
      confirm="Reset settings"
      done="Settings were reset."
      invoke={() => glossly.invoke('settings:reset')}
      after={() => {
        location.hash = 'setup';
      }}
    />
  );
}

/** Where model calls go, what Glossly never reads, and the data it keeps (Step 20.1: Privacy, the block list, and Data in one tab). */
export function PrivacyDataTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>Privacy and data</h2>
      <p className="muted">Everything stays on this computer in one database. Nothing is sent anywhere except the model calls you trigger.</p>
      <PrivacyChoice view={view} onSetUp={() => (location.hash = 'models')} />
      <BlockList view={view} />
      <h3>Your data</h3>
      <Export />
      <DeleteAll />
      <ResetSettings />
    </section>
  );
}
