// First-run setup (Step 20.3, decision 41; designed in docs/design/mockups/20-3-design-pass.html):
// one screen per step with progress dots and one primary button. A step slides in from the side it
// comes from only when the step changes; choices inside it update in place.
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Bookmark, Check, Cloud, ExternalLink, Laptop, ListChecks, MessageCircle, Reply } from 'lucide-react';
import type { KeyStatus, Privacy, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { Segmented } from '../controls/Toggles';
import { GlassIcon } from '../icons';
import { formatAccelerator, hasWorkingModel, pct } from './format';
import { SETUP_STEPS, TRY_STEPS, canContinue, joinContacts, splitContacts, tickTry, type SetupStep } from './setup-logic';
import { useAction } from './useAction';
import './setup.css';

const SAMPLE = {
  from: 'Jordan Hale',
  time: '9:41 AM',
  text: "Can you send me the slides from Tuesday's review before Friday? I'll share them with the team so they can prep for the client call.",
};

const PROVIDER_NOTES: Record<string, string> = {
  groq: 'Free tier, no card needed. The easiest place to start.',
  openai: 'Pay as you go on your OpenAI account.',
  anthropic: 'Pay as you go on your Anthropic account.',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Welcome's loop: select, the pill, the bar, Tasks, a task saved; then again. */
const DEMO: [string, number][] = [
  ['', 600],
  ['s-sel', 900],
  ['s-sel s-pill', 900],
  ['s-sel s-pill s-bar', 700],
  ['s-sel s-pill s-bar s-hover', 600],
  ['s-sel s-pill s-bar s-hover s-panel', 1100],
  ['s-sel s-pill s-bar s-hover s-panel s-saved', 1900],
  ['s-out', 500],
];

function Demo() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [i, setI] = useState(still ? DEMO.length - 2 : 0);
  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => setI((i + 1) % DEMO.length), DEMO[i]![1]);
    return () => clearTimeout(t);
  }, [i, still]);
  return (
    <div className={`demo ${DEMO[i]![0]}`} aria-hidden>
      <p className="msg">
        <span className="who-line">{SAMPLE.from}</span>
        Can you send me <span className="sel">the slides from Tuesday's review before Friday?</span> I'll share them with the team.
      </p>
      <div className="d-bar">
        <span>
          <MessageCircle size={14} strokeWidth={1.75} />
          Ask
        </span>
        <span>
          <Bookmark size={14} strokeWidth={1.75} />
          Save
        </span>
        <span className="d-tasks">
          <ListChecks size={14} strokeWidth={1.75} />
          Tasks
        </span>
        <span className="d-more">
          <Reply size={14} strokeWidth={1.75} />
          Reply
        </span>
      </div>
      <div className="d-panel">
        <div className="d-h">From this message</div>
        <div className="d-row">
          <span className="d-cb">
            <Check size={10} strokeWidth={3} />
          </span>
          <span className="d-t">Send Jordan the slides</span>
          <span className="d-due">Fri</span>
        </div>
        <div className="d-saved">
          <Check size={14} strokeWidth={2.5} />
          Saved 1 task
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <>
      <GlassIcon size={72} />
      <h1>Welcome to Glossly</h1>
      <p className="sub">Select text anywhere. Glossly offers what to do with it.</p>
      <Demo />
    </>
  );
}

const CHOICES: { value: Privacy; icon: typeof Cloud; title: string; desc: string }[] = [
  { value: 'all', icon: Cloud, title: 'All models', desc: 'Your own keys for Groq (free), OpenAI, or Anthropic, plus a model on this computer if you have one.' },
  { value: 'local', icon: Laptop, title: 'Local only', desc: 'Nothing leaves this computer. Uses Ollama or LM Studio, or simple rules without either.' },
];

function PrivacyStep({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const current = view.settings.privacy;
  const set = (value: Privacy) =>
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'privacy', value });
      if (r.error) throw new Error(r.error);
    });
  return (
    <>
      <h1>Where should AI run?</h1>
      <p className="sub">Glossly has no server. Selected text goes only where you choose, and only when the bar opens or you click an action.</p>
      <div className="setup-choices" role="radiogroup" aria-label="Where model calls go">
        {CHOICES.map(({ value, icon: Icon, title, desc }) => (
          <button key={value} type="button" role="radio" aria-checked={current === value} disabled={busy} onClick={() => current !== value && set(value)}>
            <Icon size={22} strokeWidth={1.75} aria-hidden />
            <strong>{title}</strong>
            <span>{desc}</span>
          </button>
        ))}
      </div>
      <p className="note">Never read: passwords, password managers, and apps you block. You can change this any time.</p>
      {error && <p className="error small">{error}</p>}
    </>
  );
}

function OkLine({ children }: { children: ReactNode }) {
  return (
    <div className="ok-line">
      <Check size={16} strokeWidth={2.25} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** One provider's key: paste and test (only a working key is saved), or the working key with Replace. */
function KeyField({ k }: { k: KeyStatus }) {
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const { busy, error, setError, run } = useAction();
  const working = k.hasKey && k.lastTest?.ok;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => glossly.invoke('keys:add', { provider: k.provider, key: value.trim() }));
    if (!r) return;
    if (r.ok) {
      setValue('');
      setReplacing(false);
    } else setError(r.error ?? 'The key did not work.');
  };
  if (working && !replacing)
    return (
      <div className="setup-ok">
        <OkLine>Working. {plural(k.lastTest!.models, 'model')}, saved and encrypted on this computer.</OkLine>
        <button type="button" onClick={() => setReplacing(true)}>
          Replace
        </button>
      </div>
    );
  return (
    <form className="field-big" onSubmit={(e) => void add(e)}>
      <label htmlFor={`key-${k.provider}`}>
        <span>{k.label} API key</span>
        <a href={k.keyUrl} target="_blank" rel="noreferrer">
          {k.free ? 'Get a free key' : 'Get a key'}
          <ExternalLink size={12} strokeWidth={2} aria-hidden />
        </a>
      </label>
      <div className="keyline">
        <input
          id={`key-${k.provider}`}
          type="password"
          placeholder={k.keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus
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
      </div>
      {error ? (
        <span className="error small">{error}</span>
      ) : k.hasKey && k.lastTest && !k.lastTest.ok ? (
        <span className="error small">The saved key failed its last test: {k.lastTest.error ?? 'unknown error'}</span>
      ) : (
        <span className="muted small">{PROVIDER_NOTES[k.provider] ?? ''}</span>
      )}
    </form>
  );
}

/** The local server: Ollama and LM Studio presets or another address, or the working connection. */
function LocalConnect({ view }: { view: SettingsView }) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const { busy, error, setError, run } = useAction();
  const { baseUrl, loopback, lastTest, presets } = view.local;
  const connect = async (url: string) => {
    const r = await run(() => glossly.invoke('local:connect', { baseUrl: url.trim() }));
    if (!r) return;
    if (r.ok) {
      setValue('');
      setEditing(false);
    } else setError(r.error ?? 'Could not connect.');
  };
  if (baseUrl && lastTest?.ok && !editing)
    return (
      <>
        <div className="setup-ok">
          <OkLine>
            Connected to <code>{baseUrl}</code>. {plural(lastTest.models, 'model')}.
          </OkLine>
          <button type="button" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
        {!loopback && <p className="warn small">This address is on another computer, so Local only won't use it.</p>}
      </>
    );
  return (
    <>
      <div className="row">
        {presets.map((p) => (
          <button key={p.label} type="button" disabled={busy} onClick={() => void connect(p.baseUrl)}>
            Connect to {p.label}
          </button>
        ))}
      </div>
      <form
        className="field-big"
        onSubmit={(e) => {
          e.preventDefault();
          void connect(value);
        }}
      >
        <label htmlFor="local-url">Or another address on this computer</label>
        <div className="keyline">
          <input id="local-url" placeholder="http://localhost:8080/v1" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          {editing && (
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
        {error && <span className="error small">{error}</span>}
      </form>
    </>
  );
}

/** The tab to open on: a provider that already works, else the free one. */
function firstProvider(view: SettingsView): string {
  const working = view.keys.find((k) => k.hasKey && k.lastTest?.ok);
  if (working) return working.provider;
  if (view.local.baseUrl && view.local.lastTest?.ok) return 'local';
  return (view.keys.find((k) => k.free) ?? view.keys[0])?.provider ?? 'local';
}

function ConnectStep({ view }: { view: SettingsView }) {
  const [provider, setProvider] = useState(() => firstProvider(view));
  if (view.settings.privacy === 'local')
    return (
      <>
        <h1>Connect a local model</h1>
        <p className="sub">Glossly sends model calls to Ollama or LM Studio on this computer. Nothing leaves it.</p>
        <LocalConnect view={view} />
        <div className="explain">
          <strong>No local model yet?</strong> Glossly still works without one: Save, Search, and Recall as usual; Tasks and Who is this read the
          text with simple patterns; Visualize charts tables. Ask, Reply, and the paste summary stay off until you connect one. You can do it later in
          Settings, Models.
        </div>
      </>
    );
  const k = view.keys.find((x) => x.provider === provider);
  return (
    <>
      <h1>Add a key</h1>
      <p className="sub">Pick a provider and paste a key. Glossly tests it and keeps it encrypted on this computer.</p>
      <Segmented
        label="Provider"
        full
        value={provider}
        onChange={setProvider}
        options={[
          ...view.keys.map(
            (x) =>
              [
                x.provider,
                <>
                  {x.label}
                  {x.free && <span className="free">Free</span>}
                </>,
              ] as const,
          ),
          [
            'local',
            <>
              <Laptop size={14} strokeWidth={1.75} aria-hidden />
              Local
            </>,
          ] as const,
        ]}
      />
      <div className="setup-pane" key={provider}>
        {k ? (
          <KeyField k={k} />
        ) : (
          <>
            <LocalConnect view={view} />
            <span className="muted small">Ollama and LM Studio are free apps that run models on this computer. You can add one beside a key; Local only uses it for everything.</span>
          </>
        )}
      </div>
    </>
  );
}

function YouStep({ name, contacts, onName, onContacts, onSubmit }: { name: string; contacts: string; onName: (v: string) => void; onContacts: (v: string) => void; onSubmit: () => void }) {
  return (
    // Enter in either field continues.
    <div className="setup-form" onKeyDown={(e) => e.key === 'Enter' && onSubmit()}>
      <h1>What's your name?</h1>
      <p className="sub">So Glossly can tell your messages and promises from other people's, and write replies as you.</p>
      <div className="field-big">
        <label htmlFor="you-name">Name</label>
        <input id="you-name" autoFocus maxLength={100} placeholder="First and last name" spellCheck={false} value={name} onChange={(e) => onName(e.target.value)} />
      </div>
      <div className="field-big">
        <label htmlFor="you-contacts">
          <span>
            Emails and chat names <span className="muted">(optional)</span>
          </span>
        </label>
        <input id="you-contacts" placeholder="you@example.com, @yourname" spellCheck={false} value={contacts} onChange={(e) => onContacts(e.target.value)} />
      </div>
    </div>
  );
}

const ROLE_ROWS = [
  ['fast', 'Fast'],
  ['chat', 'Chat'],
  ['decision', 'Decision'],
] as const;

function ModelsStep({ view }: { view: SettingsView }) {
  const { settings, models, keys } = view;
  const localOnly = settings.privacy === 'local';
  const find = (ref: string | null) => (ref ? models.find((m) => m.ref === ref) : undefined);
  const providerLabel = (p: string) => (p === 'local' ? 'This computer' : (keys.find((k) => k.provider === p)?.label ?? p));
  const localModel = find(settings.local.model);
  if (localOnly && !localModel)
    return (
      <>
        <h1>Ready without a model</h1>
        <p className="sub">Until you connect a local model, Glossly works on rules and patterns. Connect one any time in Settings, Models.</p>
        <div className="models-sum">
          <div>
            <b>Actions</b>
            <span className="m">Rules pick slots 3 and 4</span>
          </div>
          <div>
            <b>Tasks</b>
            <span className="m">Found with sentence patterns</span>
          </div>
          <div>
            <b>Off</b>
            <span className="m">Ask, Reply, and the paste summary</span>
          </div>
        </div>
      </>
    );
  const rows = ROLE_ROWS.map(([role, label]) => {
    if (role === 'decision' && localOnly) return { label, model: 'Rules', provider: '' };
    const ref = settings.roles[role].model;
    if (role === 'decision' && ref === null) return { label, model: 'Uses Fast', provider: '' };
    const m = localOnly && find(ref)?.provider !== 'local' ? localModel : find(ref);
    return { label, model: m?.displayName ?? 'Not set', provider: m ? providerLabel(m.provider) : '' };
  });
  return (
    <>
      <h1>Models are ready</h1>
      <p className="sub">Picked from your {localOnly ? 'local server' : 'key'}. Change any of them later in Settings, Models.</p>
      <div className="models-sum">
        {rows.map((r) => (
          <div key={r.label}>
            <b>{r.label}</b>
            <span className="m">{r.model}</span>
            {r.provider && <span className="muted small">{r.provider}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function SearchStep({ view }: { view: SettingsView }) {
  const e = view.embed;
  // The download starts when this step first shows and keeps going after setup.
  useEffect(() => {
    if (e.state === 'not_downloaded') void glossly.invoke('embed:download');
    // Only on arrival; a failure offers Try again.
  }, []);
  const p = e.state === 'ready' || e.state === 'loading' ? 100 : e.state === 'downloading' ? (e.progress ?? 0) : 0;
  const status = e.state === 'ready' ? 'Ready' : e.state === 'loading' ? 'Loading' : e.state === 'error' ? 'Failed' : e.state === 'downloading' ? pct(p / 100) : 'Waiting';
  return (
    <>
      <h1>Setting up search</h1>
      <p className="sub">
        Glossly downloads a small model (23 MB) once. It lets you find what you saved by meaning, not just the exact words, and runs only on this
        computer: nothing you save is sent anywhere to be indexed.
      </p>
      <div className="dl-card">
        <div className="dl-head">
          <span>
            <Bookmark size={16} strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <strong>Search model</strong>
            <span className="muted small">{e.model} · 23 MB</span>
          </div>
          <span className={`dl-pct${e.state === 'ready' ? ' ok' : e.state === 'error' ? ' error' : ''}`}>{status}</span>
        </div>
        <span className="bar-track" style={{ '--p': `${p}%` } as CSSProperties}>
          <i />
        </span>
        {e.state === 'error' && (
          <div className="row">
            <span className="error small grow">{e.message ?? 'The download failed.'}</span>
            <button type="button" onClick={() => void glossly.invoke('embed:download')}>
              Try again
            </button>
          </div>
        )}
      </div>
      <p className="note">You can continue now; it keeps downloading in the background.</p>
    </>
  );
}

function TryStep({ view, done, onTried }: { view: SettingsView; done: number; onTried: (step: (typeof TRY_STEPS)[number]) => void }) {
  // While this step shows, the settings window counts as an app Glossly can read from (decision
  // 11), and main reports the pill, the bar, and actions run on it.
  useEffect(() => {
    void glossly.invoke('setup:try-it', { active: true });
    const off = glossly.on('setup:tried', (e) => onTried(e.step));
    return () => {
      off();
      void glossly.invoke('setup:try-it', { active: false });
    };
  }, [onTried]);
  const items = [
    ['Select some text', 'The pill appears next to it.'],
    ['Open the bar', `Move onto the pill, or press ${formatAccelerator(view.settings.hotkey)}.`],
    ['Run an action', 'Try Tasks: it finds "send the slides before Friday".'],
  ];
  return (
    <>
      <h1>Try it here</h1>
      <p className="sub">Select a sentence in the message below, then follow the pill.</p>
      <div className="sample-msg">
        <div className="from">
          {SAMPLE.from} · {SAMPLE.time}
        </div>
        {SAMPLE.text}
      </div>
      <ul className="checklist" aria-label="Try it">
        {items.map(([title, desc], i) => (
          <li key={title} className={done > i ? 'done' : undefined}>
            <span className="t">
              <Check size={11} strokeWidth={3} aria-hidden />
            </span>
            <span>
              <strong>{title}</strong> <span className="muted">{desc}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="note">Things you save here are real; undo right after saving, or delete them later.</p>
    </>
  );
}

export function Setup({ view, onDone }: { view: SettingsView; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [back, setBack] = useState(false);
  const [name, setName] = useState(view.settings.identity.name);
  const [contacts, setContacts] = useState(() => joinContacts(view.settings.identity));
  const [tried, setTried] = useState(0);
  const [onTried] = useState(() => (s: (typeof TRY_STEPS)[number]) => setTried((d) => tickTry(d, s)));
  const { busy, error, run } = useAction();
  const id: SetupStep = SETUP_STEPS[step]!;
  const privacy = view.settings.privacy;
  const ok = canContinue(id, { privacy, hasModel: hasWorkingModel(view), name });

  const go = (d: 1 | -1) => {
    setBack(d < 0);
    setStep(step + d);
  };

  const finish = async () => {
    const done = await run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'firstRunComplete', value: true });
      if (r.error) throw new Error(r.error);
      if (view.embed.state === 'not_downloaded') await glossly.invoke('embed:download');
      return true;
    });
    if (done) onDone();
  };

  const next = async () => {
    if (!ok || busy) return;
    if (id === 'try') return finish();
    if (id === 'you') {
      const saved = await run(async () => {
        const r = await glossly.invoke('settings:set', { key: 'identity', value: { name: name.trim(), ...splitContacts(contacts) } });
        if (r.error) throw new Error(r.error);
        return true;
      });
      if (!saved) return;
    }
    go(1);
  };

  return (
    <div className="setup">
      <div className="setup-dots" role="progressbar" aria-label="Setup" aria-valuemin={1} aria-valuemax={SETUP_STEPS.length} aria-valuenow={step + 1}>
        {SETUP_STEPS.map((s, i) => (
          <span key={s} className={i === step ? 'on' : i < step ? 'done' : undefined} />
        ))}
      </div>
      <div className="setup-stage">
        <div key={id} className={`setup-step${back ? ' back' : ''}${id === 'welcome' ? ' center' : ''}`}>
          {id === 'welcome' && <Welcome />}
          {id === 'privacy' && <PrivacyStep view={view} />}
          {id === 'connect' && <ConnectStep view={view} />}
          {id === 'you' && <YouStep name={name} contacts={contacts} onName={setName} onContacts={setContacts} onSubmit={() => void next()} />}
          {id === 'models' && <ModelsStep view={view} />}
          {id === 'search' && <SearchStep view={view} />}
          {id === 'try' && <TryStep view={view} done={tried} onTried={onTried} />}
        </div>
      </div>
      <div className="setup-foot">
        <button type="button" className={`ghost lg${step === 0 ? ' invisible' : ''}`} disabled={busy} onClick={() => go(-1)}>
          Back
        </button>
        {error && <span className="error small">{error}</span>}
        <span className="spacer" />
        {id === 'try' && <span className="muted small">You can skip this</span>}
        {id === 'connect' && privacy === 'local' && <span className="muted small">Optional</span>}
        <button type="button" className="primary lg" disabled={!ok || busy} onClick={() => void next()}>
          {id === 'welcome' ? 'Get started' : id === 'try' ? 'Finish' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
