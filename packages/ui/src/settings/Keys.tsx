import { useState } from 'react';
import type { KeyStatus, LocalStatus } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { timeAgo } from './format';
import { useAction } from './useAction';

/** One provider: "Get a key" link, paste field, and Test (which saves only a working key). */
export function KeyCard({ k }: { k: KeyStatus }) {
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, setError, run } = useAction();
  const test = k.lastTest;

  const add = async () => {
    const r = await run(() => glossly.invoke('keys:add', { provider: k.provider, key: value }));
    if (!r) return;
    if (r.ok) {
      setValue('');
      setReplacing(false);
    } else setError(r.error ?? 'The key did not work.');
  };
  const retest = () => void run(() => glossly.invoke('keys:test', { provider: k.provider }));

  const showInput = !k.hasKey || replacing;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{k.label}</h3>
        {k.free && <span className="tag accent">Free tier</span>}
        <span className="spacer" />
        <a href={k.keyUrl} target="_blank" rel="noreferrer">
          Get a key
        </a>
      </div>

      {k.hasKey && (
        <div className="row">
          {test?.ok ? (
            <span className="ok">
              Working. {test.models} chat model{test.models === 1 ? '' : 's'}, tested {timeAgo(test.at)}.
            </span>
          ) : test ? (
            <span className="error">Last test failed: {test.error ?? 'unknown error'}</span>
          ) : (
            <span className="muted">Saved, not tested yet.</span>
          )}
          <span className="spacer" />
          <button disabled={busy} onClick={retest}>
            Test again
          </button>
          {!replacing && (
            <button disabled={busy} onClick={() => setReplacing(true)}>
              Replace
            </button>
          )}
          {confirming ? (
            <InlineConfirm
              prompt={`Remove the ${k.label} key?`}
              confirm="Remove"
              busy={busy}
              onConfirm={() =>
                void run(async () => {
                  await glossly.invoke('keys:remove', { provider: k.provider });
                  // Adding a key again later shows Remove, not this confirm.
                  setConfirming(false);
                })
              }
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      )}

      {showInput && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            type="password"
            className="grow"
            placeholder={k.keyPlaceholder}
            aria-label={`${k.label} API key`}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {busy ? 'Testing…' : 'Test and save'}
          </button>
          {replacing && (
            <button type="button" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          )}
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** The local model server: an address (with Ollama and LM Studio presets), Connect, and its status. */
export function LocalCard({ local }: { local: LocalStatus }) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, setError, run } = useAction();
  const test = local.lastTest;

  const connect = async (baseUrl: string) => {
    const r = await run(() => glossly.invoke('local:connect', { baseUrl }));
    if (!r) return;
    if (r.ok) {
      setValue('');
      setEditing(false);
    } else setError(r.error ?? 'Could not connect.');
  };

  const showInput = !local.baseUrl || editing;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Local model</h3>
        <span className="tag accent">Free, stays on this computer</span>
        <span className="spacer" />
        <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
          Get Ollama
        </a>
      </div>
      <p className="muted small">
        Run a model on this computer with Ollama or LM Studio. No key needed, but slower.
      </p>

      {local.baseUrl && (
        <div className="row">
          {test?.ok ? (
            <span className="ok">
              Working at <code>{local.baseUrl}</code>. {test.models} chat model{test.models === 1 ? '' : 's'}, tested {timeAgo(test.at)}.
            </span>
          ) : test ? (
            <span className="error">Last test failed: {test.error ?? 'unknown error'}</span>
          ) : (
            <span className="muted">
              Saved at <code>{local.baseUrl}</code>, not tested yet.
            </span>
          )}
          <span className="spacer" />
          <button disabled={busy} onClick={() => void run(() => glossly.invoke('local:test'))}>
            Test again
          </button>
          {!editing && (
            <button disabled={busy} onClick={() => setEditing(true)}>
              Change
            </button>
          )}
          {confirming ? (
            <InlineConfirm
              prompt="Forget the local server?"
              confirm="Remove"
              busy={busy}
              onConfirm={() =>
                void run(async () => {
                  await glossly.invoke('local:remove');
                  setConfirming(false);
                })
              }
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      )}
      {local.baseUrl && !local.loopback && <p className="warn small">This address is on another computer, so Local only won't use it.</p>}

      {showInput && (
        <>
          <div className="row">
            {local.presets.map((p) => (
              <button key={p.label} disabled={busy} onClick={() => void connect(p.baseUrl)}>
                {busy ? 'Connecting…' : `Connect to ${p.label}`}
              </button>
            ))}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void connect(value);
            }}
          >
            <input
              className="grow"
              placeholder="Or another address, such as http://localhost:8080/v1"
              aria-label="Local server address"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" className="primary" disabled={busy || !value.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </form>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
