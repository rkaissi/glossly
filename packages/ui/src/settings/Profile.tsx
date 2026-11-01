import { useEffect, useState, type KeyboardEvent } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ContextUsed, Identity, ReplyChannel, SettingsView, StyleSource, StyleView, VoiceSample } from '@glossly/core/api';
import { glossly } from '../bridge';
import { Select } from '../controls/Select';
import { Segmented, Switch } from '../controls/Toggles';
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
        <span>Chat names</span>
        <ListInput
          label="Chat names"
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
  { value: 'document', label: 'Document' },
  { value: 'any', label: 'Any' },
];

/** Reply's voice samples: up to 5 pasted here, plus replies you edited before inserting or copying. */
/**
 * Loads now and again whenever the settings window gets focus back: Reply learns and adds
 * samples while the user is in another app, and nothing pushes those changes here.
 * Returns the cleanup for an effect.
 */
function reloadOnFocus(load: () => void): () => void {
  load();
  window.addEventListener('focus', load);
  return () => window.removeEventListener('focus', load);
}

/**
 * Examples of your writing (decision 84): the ones you added (up to 5, each with where you wrote
 * it) and the ones taken from replies you edited, as cards, switched with a segmented control.
 */
function WritingExamples() {
  const [samples, setSamples] = useState<VoiceSample[] | null>(null);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [which, setWhich] = useState<'pasted' | 'edits'>('pasted');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => reloadOnFocus(() => void glossly.invoke('voice:list').then(setSamples)), []);
  const pasted = (samples ?? []).filter((v) => v.origin === 'pasted');
  const edits = (samples ?? []).filter((v) => v.origin !== 'pasted');
  const remove = (id: string) =>
    void run(async () => {
      setSamples(await glossly.invoke('voice:remove', { id }));
      setPendingId(null);
    });
  const add = () =>
    void run(async () => {
      setSamples(await glossly.invoke('voice:add', { text }));
      setText('');
      setAdding(false);
    });
  const label = (id: string, platform: VoicePlatform) =>
    void run(async () => {
      setSamples(await glossly.invoke('voice:label', { id, channel: platform === 'any' ? null : platform }));
    });
  const card = (v: VoiceSample) => (
    <div key={v.id} className="example">
      <p className="example-text">{v.text}</p>
      <div className="example-foot">
        {v.origin === 'pasted' ? (
          <Select<VoicePlatform>
            size="sm"
            className="voice-platform"
            label="Where you wrote this"
            value={v.channel ?? 'any'}
            disabled={busy || pendingId === v.id}
            onChange={(p) => label(v.id, p)}
            options={VOICE_PLATFORMS}
          />
        ) : (
          v.channel && <span className="place-pill">{PLACE_LABELS[v.channel]}</span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={`delete-btn${pendingId === v.id ? ' armed' : ''}`}
          title={pendingId === v.id ? 'Remove this example' : 'Remove'}
          aria-label={pendingId === v.id ? 'Confirm: remove this example' : 'Remove'}
          disabled={busy}
          onClick={() => (pendingId === v.id ? remove(v.id) : setPendingId(v.id))}
          onBlur={() => setPendingId(null)}
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
          <span>Delete</span>
        </button>
      </div>
    </div>
  );
  const shown = which === 'pasted' ? pasted : edits;
  return (
    <div className="field">
      <div className="examples-head">
        <strong>Examples of your writing</strong>
        <span className="spacer" />
        <Segmented
          size="sm"
          label="Examples"
          value={which}
          options={[
            ['pasted', `You added ${pasted.length}`],
            ['edits', `From your edits ${edits.length}`],
          ]}
          onChange={setWhich}
        />
      </div>
      <div className="examples">
        {shown.map(card)}
        {which === 'pasted' &&
          pasted.length < 5 &&
          (adding ? (
            <div className="example">
              <textarea autoFocus rows={4} value={text} maxLength={2000} placeholder="Paste a message you wrote" aria-label="A message you wrote" onChange={(e) => setText(e.target.value)} />
              <div className="example-foot">
                <span className="muted small">{pasted.length} of 5</span>
                <span className="spacer" />
                <button className="sm" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button className="sm primary" disabled={busy || !text.trim()} onClick={add}>
                  Add
                </button>
              </div>
            </div>
          ) : (
            <button className="example add" onClick={() => setAdding(true)}>
              <Plus size={16} strokeWidth={1.75} aria-hidden />
              <span>Paste a message you wrote</span>
              <span className="muted small">{pasted.length} of 5</span>
            </button>
          ))}
        {which === 'edits' && edits.length === 0 && <p className="muted small">Replies and texts you edit before using them show up here.</p>}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Which actions taught a habit, for its row. */
const SOURCE_WORDS: Record<StyleSource, string> = { reply: 'Reply', write: 'Write here' };
const sourceWords = (sources: StyleSource[]) => sources.map((s) => SOURCE_WORDS[s]).join(' and ');
/** The places Profile can filter by; the list shows only the ones that have something. */
const PLACE_LABELS: Record<ReplyChannel, string> = { email: 'Email', messaging: 'Messaging', work_chat: 'Work chat', document: 'Documents', other: 'Other' };
const KIND_WORDS: Record<ContextUsed['kind'], string> = { note: 'saved notes', person: 'people', task: 'tasks', event: 'events' };
type PlaceFilter = ReplyChannel | 'all';
const REPLY_PLACES: ReplyChannel[] = ['email', 'messaging', 'work_chat', 'document', 'other'];

/** One habit, whatever taught it: a counted preference, a style note, or a kind Write here leaves out. */
interface Habit {
  key: string;
  text: string;
  how: string;
  /** "Everywhere", a place, or "Email and Work chat" for one that holds in several. */
  place: string;
  forget: () => Promise<StyleView>;
}

/**
 * How you write (decision 84): one list of habits in plain sentences, whatever taught them
 * (counted preferences, the model's notes, the kinds of saved data Write here leaves out), each
 * with how it was learned and its place. A place filter narrows it; each can be forgotten. Habits
 * about one person are on that person's record.
 */
function HowYouWrite({ learning }: { learning: boolean }) {
  const [view, setView] = useState<StyleView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [place, setPlace] = useState<PlaceFilter>('all');
  const { busy, error, run } = useAction();
  useEffect(() => reloadOnFocus(() => void glossly.invoke('style:get').then(setView)), [learning]);
  const prefs = (view?.preferences ?? []).filter((p) => p.scope !== 'person');
  const notes = view?.notes ?? [];
  const dropped = view?.dropped ?? [];
  const placeOf = (channel: ReplyChannel | null, places?: ReplyChannel[]) =>
    channel ? PLACE_LABELS[channel] : places?.length ? places.map((c) => PLACE_LABELS[c]).join(' and ') : 'Everywhere';
  const inPlace = (channel: ReplyChannel | null, places?: ReplyChannel[]) => place === 'all' || channel === place || (channel === null && (!places || places.includes(place)));
  const habits: Habit[] = [
    ...prefs
      .filter((p) => inPlace(p.channel, p.places))
      .map(
        (p): Habit => ({
          key: `${p.dimension}:${p.scope}:${p.relationship ?? ''}:${p.channel}`,
          text: p.relationship ? `${p.label} ${p.where}` : p.label,
          how: [`${p.agree} of ${p.of} times`, sourceWords(p.sources)].filter(Boolean).join(' · '),
          place: placeOf(p.channel, p.scope === 'everywhere' ? p.places : undefined),
          forget: () =>
            glossly.invoke('style:forget', {
              dimension: p.dimension,
              channel: p.channel,
              personId: p.personId,
              relationship: p.relationship,
              ...(p.scope === 'everywhere' && { pole: p.pole }),
            }),
        }),
      ),
    ...notes
      .filter((n) => inPlace(n.channel))
      .map((n): Habit => ({ key: `note:${n.id}`, text: n.text, how: 'From your edits and requests', place: placeOf(n.channel), forget: () => glossly.invoke('style:note-remove', { id: n.id }) })),
    ...dropped
      .filter((d) => inPlace(d.channel))
      .map(
        (d): Habit => ({
          key: `dropped:${d.channel}:${d.kind}`,
          text: `Leaves out your ${KIND_WORDS[d.kind]}`,
          how: 'You took them out of Write here',
          place: placeOf(d.channel),
          forget: () => glossly.invoke('style:forget-dropped', { channel: d.channel, kind: d.kind }),
        }),
      ),
  ];
  const places = REPLY_PLACES.filter((c) => prefs.some((p) => p.channel === c || p.places?.includes(c)) || notes.some((n) => n.channel === c) || dropped.some((d) => d.channel === c));
  const nothing = prefs.length === 0 && notes.length === 0 && dropped.length === 0;
  const forget = (h: Habit) =>
    void run(async () => {
      setView(await h.forget());
      setPending(null);
    });
  return (
    <div className="field">
      {!learning && <p className="muted small">Learning is off: what was learned is still used, and nothing new is learned.</p>}
      {learning && view && nothing && <p className="muted small">Nothing learned yet. After a few replies or texts, your habits show up here.</p>}
      {places.length > 1 && (
        <Segmented
          size="sm"
          label="Place"
          value={places.includes(place as ReplyChannel) ? place : 'all'}
          options={[['all', 'All'] as const, ...places.map((c) => [c, PLACE_LABELS[c]] as const)]}
          onChange={(v) => {
            setPlace(v);
            setPending(null);
          }}
        />
      )}
      {habits.length > 0 && (
        <ul className="list habits">
          {habits.map((h) => (
            <li key={h.key}>
              <span className="grow">
                <span className="habit-text">{h.text}</span>
                <span className="muted small block">{h.how}</span>
              </span>
              <span className="place-pill">{h.place}</span>
              <button
                type="button"
                className={`delete-btn${pending === h.key ? ' armed' : ''}`}
                title={pending === h.key ? 'Forget this' : 'Forget'}
                aria-label={pending === h.key ? 'Confirm: forget this' : 'Forget'}
                disabled={busy}
                onClick={() => (pending === h.key ? forget(h) : setPending(h.key))}
                onBlur={() => setPending(null)}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                <span>Forget</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The learning switch, in the How you write header (decision 84). */
function LearnSwitch({ learning }: { learning: boolean }) {
  const { busy, error, run } = useAction();
  const toggle = (on: boolean) =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'replyLearning', value: on });
      if (r.error) throw new Error(r.error);
    });
  return (
    <label className="group-switch">
      <span>Learn as I write</span>
      <Switch label="Learn as I write" checked={learning} disabled={busy} onChange={toggle} />
      {error && <span className="error small">{error}</span>}
    </label>
  );
}

/**
 * What Glossly knows about you (decision 78): facts Ask noted, always in its prompt, in the same
 * list shape as a person's facts. They can be added, reworded, or removed here, since a wrong one
 * would color every answer.
 */
function AboutMe({ facts }: { facts: SettingsView['settings']['aboutMe'] }) {
  const { busy, error, run } = useAction();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);
  const write = (next: SettingsView['settings']['aboutMe']) =>
    run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'aboutMe', value: next });
      if (r.error) throw new Error(r.error);
    });
  const saveEdit = () => {
    const text = editing?.text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!editing) return;
    if (!text) return setEditing(null);
    const next = editing.id
      ? facts.map((f) => (f.id === editing.id ? { ...f, text } : f))
      : [...facts, { id: crypto.randomUUID(), text, at: new Date().toISOString() }].slice(-50);
    void write(next).then(() => setEditing(null));
  };
  const field = (
    <li key="editing">
      <input
        className="grow"
        value={editing?.text ?? ''}
        maxLength={300}
        autoFocus
        placeholder="Something about you, like where you work"
        aria-label="Fact about you"
        onChange={(e) => setEditing((x) => (x ? { ...x, text: e.target.value } : x))}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') saveEdit();
          else if (e.key === 'Escape') setEditing(null);
        }}
      />
      <button className="sm" disabled={busy} onClick={() => setEditing(null)}>
        Cancel
      </button>
      <button className="sm primary" disabled={busy || !editing?.text.trim()} onClick={saveEdit}>
        Save
      </button>
    </li>
  );
  return (
    <div className="field">
      <ul className="list facts-me">
        {facts.map((f) =>
          editing?.id === f.id ? (
            field
          ) : (
            <li key={f.id}>
              <span className="grow">{f.text}</span>
              <span className="fact-acts">
                <button className="icon-btn sm" title="Reword" aria-label="Reword" disabled={busy} onClick={() => setEditing({ id: f.id, text: f.text })}>
                  <Pencil size={14} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  className={`delete-btn${pendingId === f.id ? ' armed' : ''}`}
                  title={pendingId === f.id ? 'Remove this' : 'Remove'}
                  aria-label={pendingId === f.id ? 'Confirm: remove this' : 'Remove'}
                  disabled={busy}
                  onClick={() => (pendingId === f.id ? void write(facts.filter((x) => x.id !== f.id)) : setPendingId(f.id))}
                  onBlur={() => setPendingId(null)}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                  <span>Delete</span>
                </button>
              </span>
            </li>
          ),
        )}
        {editing?.id === null ? (
          field
        ) : (
          <li key="add">
            <button className="ghost add-fact" onClick={() => setEditing({ id: null, text: '' })}>
              <Plus size={14} strokeWidth={1.75} aria-hidden />
              Add something about you
            </button>
          </li>
        )}
      </ul>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Your name, emails, and chat names, saved a moment after you stop typing (no Save button, decision 84). */
function WhoYouAre({ saved }: { saved: Identity }) {
  const [draft, setDraft] = useState<Identity>(saved);
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');
  const { error, run } = useAction();
  // A save from elsewhere (setup) replaces an untouched draft.
  useEffect(() => setDraft((d) => (same(d, saved) ? d : saved)), [saved]);
  const dirty = !same(draft, saved);
  useEffect(() => {
    if (!dirty || !draft.name.trim()) return;
    const t = setTimeout(
      () =>
        void run(async () => {
          const r = await glossly.invoke('settings:set', { key: 'identity', value: { ...draft, name: draft.name.trim() } });
          if (r.error) throw new Error(r.error);
          setStatus('saved');
        }),
      700,
    );
    return () => clearTimeout(t);
  }, [draft, dirty]);
  return (
    <div className="field">
      <IdentityForm
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setStatus('idle');
        }}
      />
      <div className="row form-status">
        {!draft.name.trim() && <span className="muted small">Your name is required.</span>}
        {status === 'saved' && !dirty && <span className="ok small">Saved</span>}
        {error && <span className="error small">{error}</span>}
      </div>
    </div>
  );
}

/**
 * Profile (decision 84): two groups. Who you are: your name and addresses, then what Glossly
 * knows about you. How you write: the habits Reply and Write here learned, with the learning
 * switch in the header, then examples of your writing.
 */
export function ProfileTab({ view }: { view: SettingsView }) {
  const learning = view.settings.replyLearning;
  return (
    <section>
      <h2>Profile</h2>
      <p className="muted">Who you are and how you write, so Glossly can tell your messages from other people's and write as you. It stays on this computer.</p>

      <div className="group-head">
        <div>
          <h3>Who you are</h3>
          <p className="muted small">Your name and addresses tell your messages apart. The facts below go into every answer and draft.</p>
        </div>
      </div>
      <WhoYouAre saved={view.settings.identity} />
      <AboutMe facts={view.settings.aboutMe} />

      <div className="group-head">
        <div>
          <h3>How you write</h3>
          <p className="muted small">Reply and Write here learn from the drafts you pick, the edits you make, and what you ask for. A habit seen in two places applies everywhere.</p>
        </div>
        <LearnSwitch learning={learning} />
      </div>
      <HowYouWrite learning={learning} />
      <WritingExamples />
    </section>
  );
}
