import { useEffect, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { Identity, SettingsView, VoiceSample } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { parseEmail, parseHandle } from './format';
import { useAction } from './useAction';

/** Chips plus an input: Enter, comma, or leaving the field adds what was typed. */
function ListInput({
  values,
  onChange,
  parse,
  placeholder,
  label,
  invalid,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  parse: (raw: string) => string | null;
  placeholder: string;
  label: string;
  invalid: string;
}) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const add = () => {
    if (!text.trim()) return true;
    const v = parse(text);
    if (!v) {
      setBad(true);
      return false;
    }
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase()) && values.length < 10) onChange([...values, v]);
    setText('');
    setBad(false);
    return true;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
  };
  return (
    <div className="list-input">
      <div className="chips-field">
        {values.map((v) => (
          <span key={v} className="chip-tag">
            {v}
            <button className="chip-x" title={`Remove ${v}`} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          </span>
        ))}
        <input
          aria-label={label}
          value={text}
          placeholder={values.length ? '' : placeholder}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void add()}
        />
      </div>
      {bad && <p className="error small">{invalid}</p>}
    </div>
  );
}

/** Name, emails, and handles: how Glossly tells your messages and promises from other people's. */
export function IdentityForm({ value, onChange, autoFocus }: { value: Identity; onChange: (next: Identity) => void; autoFocus?: boolean }) {
  return (
    <div className="identity">
      <label className="form-row">
        <span>Your name</span>
        <input
          autoFocus={autoFocus}
          value={value.name}
          maxLength={100}
          placeholder="First and last name"
          spellCheck={false}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <div className="form-row">
        <span>Emails</span>
        <ListInput
          label="Emails"
          values={value.emails}
          onChange={(emails) => onChange({ ...value, emails })}
          parse={parseEmail}
          placeholder="you@work.com, you@home.com"
          invalid="That doesn't look like an email address."
        />
      </div>
      <div className="form-row">
        <span>Handles</span>
        <ListInput
          label="Handles"
          values={value.handles}
          onChange={(handles) => onChange({ ...value, handles })}
          parse={parseHandle}
          placeholder="Slack or Discord names, e.g. rayan.k"
          invalid="Type a handle."
        />
      </div>
    </div>
  );
}

const same = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b);

/** Spec: Reply's voice samples are up to 5 pasted here, plus replies you inserted. */
function VoiceSamples() {
  const [samples, setSamples] = useState<VoiceSample[] | null>(null);
  const [text, setText] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void glossly.invoke('voice:list').then(setSamples);
  }, []);
  const pasted = (samples ?? []).filter((v) => v.origin === 'pasted');
  const inserted = (samples ?? []).filter((v) => v.origin !== 'pasted');
  const remove = (id: string) =>
    void run(async () => {
      setSamples(await glossly.invoke('voice:remove', { id }));
      setPendingId(null);
    });
  const add = () =>
    void run(async () => {
      setSamples(await glossly.invoke('voice:add', { text }));
      setText('');
    });
  const sample = (v: VoiceSample) => (
    <li key={v.id}>
      <span className="grow voice-text">{v.text}</span>
      {pendingId === v.id ? (
        <InlineConfirm prompt="Remove this sample?" confirm="Remove" busy={busy} onConfirm={() => remove(v.id)} onCancel={() => setPendingId(null)} />
      ) : (
        <button className="icon-btn danger" title="Remove" aria-label="Remove sample" disabled={busy} onClick={() => setPendingId(v.id)}>
          <X size={15} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </li>
  );
  return (
    <div className="field">
      <div className="field-label">
        <strong>How you write</strong>
        <p className="muted small">
          Paste up to 5 messages you wrote, so Reply drafts sound like you. Replies you insert are added on their own (the last 20 are kept). Samples
          are sent to your model provider only inside a Reply request.
        </p>
      </div>
      {pasted.length > 0 && <ul className="list">{pasted.map(sample)}</ul>}
      {pasted.length < 5 && (
        <div className="voice-add">
          <textarea rows={3} value={text} maxLength={2000} placeholder="Paste a message you wrote" onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button disabled={busy || !text.trim()} onClick={add}>
              Add sample
            </button>
            <span className="muted small">{pasted.length} of 5</span>
          </div>
        </div>
      )}
      {inserted.length > 0 && (
        <details className="small">
          <summary className="muted">From replies you inserted ({inserted.length})</summary>
          <ul className="list">{inserted.map(sample)}</ul>
        </details>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function ProfileTab({ view }: { view: SettingsView }) {
  const saved = view.settings.identity;
  const [draft, setDraft] = useState<Identity>(saved);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);
  // A save from elsewhere (setup in another window state) replaces an untouched draft.
  useEffect(() => setDraft((d) => (same(d, saved) ? d : saved)), [saved]);

  const dirty = !same(draft, saved);
  const save = () =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'identity', value: { ...draft, name: draft.name.trim() } });
      if (r.error) throw new Error(r.error);
      setDone(true);
    });

  return (
    <section>
      <h2>Profile</h2>
      <p className="muted">
        Glossly uses this to tell your own messages and promises from other people's, and to write replies as you. It stays on this computer and is
        sent to a model provider only as part of a request you start (Ask, Reply, What did I promise).
      </p>
      <div className="field">
        <div className="field-label">
          <strong>You</strong>
        </div>
        <IdentityForm
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setDone(false);
          }}
        />
        <div className="row">
          <button className="primary" disabled={!dirty || busy || !draft.name.trim()} onClick={save}>
            Save
          </button>
          {done && !dirty && <span className="ok small">Saved</span>}
          {!draft.name.trim() && <span className="muted small">Your name is required.</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      </div>
      <VoiceSamples />
    </section>
  );
}
