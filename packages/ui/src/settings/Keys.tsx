import { useState } from 'react';
import type { KeyStatus, SettingsView } from '@glossly/core/api';
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
              onConfirm={() => void run(() => glossly.invoke('keys:remove', { provider: k.provider }))}
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

export function KeysTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>Keys</h2>
      <p className="muted">
        Glossly has no server. Your keys are encrypted on this computer and sent only to their own provider. Each key is tested by listing the
        provider's models.
      </p>
      {view.keys.map((k) => (
        <KeyCard key={k.provider} k={k} />
      ))}
    </section>
  );
}
