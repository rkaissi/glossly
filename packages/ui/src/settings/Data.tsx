import { useState } from 'react';
import type { EmbedStatus, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { pct } from './format';
import { BlockList } from './General';
import { CallLog, PrivacyChoice, SavedInAnswers } from './Privacy';
import { useAction } from './useAction';

const EMBED_STATE: Record<EmbedStatus['state'], string> = {
  not_downloaded: 'Not downloaded',
  downloading: 'Downloading',
  loading: 'Loading',
  ready: 'Ready',
  error: 'Failed',
};

function EmbedLine({ embed }: { embed: EmbedStatus }) {
  const progress = embed.state === 'downloading' && embed.progress !== undefined ? ` ${pct(embed.progress / 100)}` : '';
  return (
    <span className={embed.state === 'error' ? 'error' : embed.state === 'ready' ? 'ok' : undefined}>
      {EMBED_STATE[embed.state]}
      {progress}
      {embed.state === 'error' && embed.message ? `: ${embed.message}` : ''}
    </span>
  );
}

/** Download size of the default embedding model (all-MiniLM-L6-v2, quantized). */
const EMBED_SIZE = '23 MB';

/** The local embedding model (shown in Models): its name and size, then its status. */
export function Embeddings({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const e = view.embed;
  const canStart = e.state === 'not_downloaded' || e.state === 'error';
  return (
    <div className="field">
      <div className="field-label">
        <strong>Search model</strong>
        <p className="muted small">Finds related notes in what you save. Runs on this computer.</p>
      </div>
      <div className="row">
        <span className="tag">{e.model.split('/').pop()}</span>
        <span className="tag">{EMBED_SIZE}</span>
        <span className="spacer" />
        {e.pending > 0 && (
          <span className="muted small">
            {e.pending} saved item{e.pending === 1 ? '' : 's'} waiting
          </span>
        )}
        <EmbedLine embed={e} />
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
        <p className="muted small">Download everything Glossly keeps as a file. Keys aren't included.</p>
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
      <div className="row">
        {confirming ? (
          <InlineConfirm prompt={props.warning} confirm={props.confirm} busy={busy} onConfirm={() => void go()} onCancel={() => setConfirming(false)} />
        ) : (
          <button
            className="danger"
            onClick={() => {
              setDone(false);
              setConfirming(true);
            }}
          >
            {props.button}
          </button>
        )}
        {done && !confirming && <span className="ok small">{props.done}</span>}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function DeleteAll() {
  return (
    <Destructive
      title="Delete all data"
      description="Erase saved items, people, tasks, and history. Keys and settings stay."
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
      description="Remove your keys and put every setting back to its default. Saved items stay, and setup runs again."
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
      <h2>Privacy</h2>
      <p className="muted">Everything Glossly keeps stays on this computer. Only model calls leave it.</p>
      <PrivacyChoice view={view} onSetUp={() => (location.hash = 'models')} />
      <BlockList view={view} />
      <SavedInAnswers view={view} />
      <CallLog view={view} />
      <h3>Your data</h3>
      <Export />
      <DeleteAll />
      <ResetSettings />
    </section>
  );
}
