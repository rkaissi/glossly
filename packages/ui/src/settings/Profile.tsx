import { useEffect, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { Identity, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
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
    </section>
  );
}
