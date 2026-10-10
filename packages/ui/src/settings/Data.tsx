import { useState } from 'react';
import type { EmbedStatus, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { pct } from './format';
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

function Embeddings({ view }: { view: SettingsView }) {
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

function DeleteAll() {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const go = async () => {
    const ok = await run(async () => {
      await glossly.invoke('data:delete-all');
      return true;
    });
    if (ok) {
      setConfirming(false);
      location.hash = 'setup';
    }
  };
  return (
    <div className="field">
      <div className="field-label">
        <strong>Delete all data</strong>
        <p className="muted small">
          Removes saved items, collections, people, usage metrics, settings, and your API keys from this computer. The embedding model stays downloaded.
          Setup starts again afterwards.
        </p>
      </div>
      {confirming ? (
        <div className="confirm">
          <span>This cannot be undone. Export first if you want a copy.</span>
          <span className="spacer" />
          <button onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
          <button className="danger solid" onClick={() => void go()} disabled={busy}>
            Delete everything
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="danger" onClick={() => setConfirming(true)}>
            Delete all data…
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function DataTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>Data</h2>
      <p className="muted">Everything stays on this computer in one database. Nothing is sent anywhere except the model calls you trigger.</p>
      <Embeddings view={view} />
      <Export />
      <DeleteAll />
    </section>
  );
}
