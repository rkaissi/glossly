import { useEffect, useState, type KeyboardEvent } from 'react';
import { Trash2, X } from 'lucide-react';
import type { Identity, ReplyChannel, SettingsView, StylePreferenceView, StyleView, VoiceSample } from '@glossly/core/api';
import { glossly } from '../bridge';
import { Select } from '../controls/Select';
import { Switch } from '../controls/Toggles';
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
function IdentityForm({ value, onChange, autoFocus }: { value: Identity; onChange: (next: Identity) => void; autoFocus?: boolean }) {
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
          placeholder="Slack or Discord names, e.g. alex.m"
          invalid="Type a handle."
        />
      </div>
    </div>
  );
}

const same = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b);

/** Where a pasted sample was written (decision 59); Any is null, a sample for every platform. */
type VoicePlatform = ReplyChannel | 'any';
const VOICE_PLATFORMS: { value: VoicePlatform; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'messaging', label: 'Messaging app' },
  { value: 'work_chat', label: 'Work chat' },
  { value: 'any', label: 'Any' },
];

/** Reply's voice samples: up to 5 pasted here, plus replies you edited before inserting or copying. */
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
  const label = (id: string, platform: VoicePlatform) =>
    void run(async () => {
      setSamples(await glossly.invoke('voice:label', { id, channel: platform === 'any' ? null : platform }));
    });
  const sample = (v: VoiceSample) => (
    <li key={v.id}>
      <span className="grow voice-text">{v.text}</span>
      {v.origin === 'pasted' && (
        <Select<VoicePlatform>
          size="sm"
          className="voice-platform"
          label="Where you wrote this"
          value={v.channel ?? 'any'}
          disabled={busy || pendingId === v.id}
          onChange={(p) => label(v.id, p)}
          options={VOICE_PLATFORMS}
        />
      )}
      <button
        type="button"
        className={`delete-btn${pendingId === v.id ? ' armed' : ''}`}
        title={pendingId === v.id ? 'Remove this sample' : 'Remove sample'}
        aria-label={pendingId === v.id ? 'Confirm: remove sample' : 'Remove sample'}
        disabled={busy}
        onClick={() => (pendingId === v.id ? remove(v.id) : setPendingId(v.id))}
        onBlur={() => setPendingId(null)}
      >
        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        <span>Delete</span>
      </button>
    </li>
  );
  return (
    <div className="field">
      <div className="field-label">
        <strong>How you write</strong>
        <p className="muted small">
          Paste a few messages you wrote, and say where, so replies sound like you. Replies you edit are added on their own.
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
          <summary className="muted">From replies you edited or wrote ({inserted.length})</summary>
          <ul className="list">{inserted.map(sample)}</ul>
        </details>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/**
 * What Reply learned from the drafts you pick and edit: preferences counted in code (per kind of
 * app and per person) and the model's style notes. Each can be removed; one switch turns it off.
 */
function LearnedStyle({ learning }: { learning: boolean }) {
  const [view, setView] = useState<StyleView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void glossly.invoke('style:get').then(setView);
  }, [learning]);
  const prefKey = (p: StylePreferenceView) => `${p.dimension}:${p.personId ?? `${p.relationship ?? ''}:${p.channel}`}`;
  const forget = (p: StylePreferenceView) =>
    void run(async () => {
      setView(await glossly.invoke('style:forget', { dimension: p.dimension, channel: p.channel, personId: p.personId, relationship: p.relationship }));
      setPending(null);
    });
  const removeNote = (id: string) =>
    void run(async () => {
      setView(await glossly.invoke('style:note-remove', { id }));
      setPending(null);
    });
  const toggle = (on: boolean) =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'replyLearning', value: on });
      if (r.error) throw new Error(r.error);
    });
  const row = (key: string, text: string, meta: string | null, onRemove: () => void) => (
    <li key={key}>
      <span className="grow">
        {text}
        {meta && <span className="muted small"> · {meta}</span>}
      </span>
      <button
        type="button"
        className={`delete-btn${pending === key ? ' armed' : ''}`}
        title={pending === key ? 'Forget this' : 'Forget'}
        aria-label={pending === key ? 'Confirm: forget this' : 'Forget'}
        disabled={busy}
        onClick={() => (pending === key ? onRemove() : setPending(key))}
        onBlur={() => setPending(null)}
      >
        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        <span>Forget</span>
      </button>
    </li>
  );
  const prefs = view?.preferences ?? [];
  const notes = view?.notes ?? [];
  return (
    <div className="field">
      <div className="toggle">
        <span>
          <strong>Learn from the drafts I pick and edit</strong>
          <span className="muted small block">
            Reply learns your habits from the drafts you choose and the edits you make. What it learned shows here.
          </span>
        </span>
        <Switch label="Learn from the drafts I pick and edit" checked={learning} disabled={busy} onChange={toggle} />
      </div>
      {learning && view && prefs.length === 0 && notes.length === 0 && (
        <p className="muted small">Nothing learned yet. After a few replies, what you tend to pick shows here.</p>
      )}
      {prefs.length > 0 && (
        <ul className="list">{prefs.map((p) => row(prefKey(p), `${p.label} ${p.where}`, `${p.agree} of ${p.of}`, () => forget(p)))}</ul>
      )}
      {notes.length > 0 && (
        <>
          <p className="muted small">Notes from your edits</p>
          <ul className="list">{notes.map((n) => row(`note:${n.id}`, n.text, n.where, () => removeNote(n.id)))}</ul>
        </>
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
        Lets Glossly tell your messages from other people's and write replies as you. It stays on this computer.
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
        <div className="row form-actions">
          <button className="primary" disabled={!dirty || busy || !draft.name.trim()} onClick={save}>
            Save
          </button>
          {done && !dirty && <span className="ok small">Saved</span>}
          {!draft.name.trim() && <span className="muted small">Your name is required.</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      </div>
      <VoiceSamples />
      <LearnedStyle learning={view.settings.replyLearning} />
    </section>
  );
}
