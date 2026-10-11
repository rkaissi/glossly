import { useEffect, useState } from 'react';
import type { Identity, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { EmbedLine } from './Data';
import { formatAccelerator, hasWorkingModel } from './format';
import { KeyCard, LocalCard } from './Keys';
import { PrivacyChoice } from './Privacy';
import { IdentityForm } from './Profile';
import { RolePickers } from './Models';
import { useAction } from './useAction';

const STEPS = ['Welcome', 'You', 'Keys', 'Models', 'Try it'] as const;

const SAMPLE_PARAGRAPH =
  'Octopuses have three hearts and blue blood. Two of the hearts pump blood through the gills, while the third keeps it moving through the rest of the body. The blood is blue because it carries oxygen with a copper-based protein called hemocyanin instead of the iron-based hemoglobin humans use.';

const SAMPLE_MESSAGE = {
  from: 'Maya Lin',
  time: '9:41 AM',
  text: "Hey! Can you send me the slides from Tuesday's review before Friday? I'll share them with Daniel Park so he can prep for the client call next week.",
};

function Welcome({ view }: { view: SettingsView }) {
  return (
    <>
      <h1>Welcome to Glossly</h1>
      <ul className="intro">
        <li>Select text in any app and a small pill appears next to it.</li>
        <li>Hover it, or press {formatAccelerator(view.settings.hotkey)}, to open a bar of actions picked for what you selected.</li>
        <li>Ask about it, save it with a note on why, draft a reply to a message, see who someone is, or keep track of what you promised.</li>
      </ul>
      <div className="card">
        <h3>Privacy</h3>
        <ul className="small">
          <li>Glossly reads the text you select. It reads the text around it only when you open the bar or click an action.</li>
          <li>It never records keystrokes; the hotkey is its only keyboard shortcut. Password fields and password managers are never read.</li>
          <li>
            Everything is stored on this computer. Selected text goes only to the provider whose key you add: when the bar opens, to pick actions, and
            when you click Ask, Save, Reply, Who is this, or Tasks. Choose Local only in the next steps and nothing leaves this computer.
          </li>
        </ul>
      </div>
      <div className="card">
        <h3>One download</h3>
        <p className="small muted">
          At the end of setup, Glossly downloads a small local model ({view.embed.model}, about 23 MB) that indexes what you save. It runs on this
          computer; nothing you save is sent anywhere to be indexed.
        </p>
      </div>
    </>
  );
}

function You({ identity, onChange }: { identity: Identity; onChange: (next: Identity) => void }) {
  return (
    <>
      <h1>About you</h1>
      <p className="muted">
        Glossly uses your name, emails, and handles to tell your own messages and promises from other people's, and to write replies as you. Your name is
        required; add the emails and chat names people see when you write to them.
      </p>
      <div className="card">
        <IdentityForm value={identity} onChange={onChange} autoFocus />
      </div>
    </>
  );
}

function Keys({ view }: { view: SettingsView }) {
  const localOnly = view.settings.privacy === 'local';
  return (
    <>
      <h1>Choose your models</h1>
      <p className="muted">
        Glossly uses your own API keys or a model on this computer, and has no server. Groq has a free tier that needs no card, so it is the easiest
        place to start.
      </p>
      <PrivacyChoice view={view} onSetUp={() => document.getElementById('local-card')?.scrollIntoView({ behavior: 'smooth' })} />
      {!localOnly && view.keys.map((k) => <KeyCard key={k.provider} k={k} />)}
      <div id="local-card">
        <LocalCard local={view.local} />
      </div>
    </>
  );
}

function Models({ view }: { view: SettingsView }) {
  return (
    <>
      <h1>Models</h1>
      <p className="muted">These are filled in from your keys. Change any of them now or later in Settings.</p>
      <RolePickers view={view} />
    </>
  );
}

function TryIt({ view }: { view: SettingsView }) {
  // While this step shows, the settings window counts as an app Glossly can read from.
  useEffect(() => {
    void glossly.invoke('setup:try-it', { active: true });
    return () => void glossly.invoke('setup:try-it', { active: false });
  }, []);
  const hotkey = formatAccelerator(view.settings.hotkey);
  return (
    <>
      <h1>Try it</h1>
      <ol className="steps small">
        <li>Drag across a sentence below, or double-click a word. The pill appears next to it.</li>
        <li>Move the mouse onto the pill to open the bar. Or select text and press {hotkey}, then use the number keys.</li>
        <li>Click Ask for a quick explanation, or Save to keep it with a note.</li>
      </ol>
      <div className="sample">
        <div className="sample-label muted small">A paragraph</div>
        <p>{SAMPLE_PARAGRAPH}</p>
      </div>
      <div className="sample">
        <div className="sample-label muted small">A chat message</div>
        <div className="message">
          <div className="message-head">
            <strong>{SAMPLE_MESSAGE.from}</strong> <span className="muted small">{SAMPLE_MESSAGE.time}</span>
          </div>
          <p>{SAMPLE_MESSAGE.text}</p>
        </div>
      </div>
      <p className="muted small">Things you save here are real; delete them later or undo right after saving.</p>
    </>
  );
}

export function Setup({ view, onDone }: { view: SettingsView; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [identity, setIdentity] = useState<Identity>(view.settings.identity);
  const { busy, error, run } = useAction();
  const last = step === STEPS.length - 1;
  // Local only works without any model (rules and patterns), so it needs neither a key nor a local server.
  const canNext = step === 1 ? identity.name.trim().length > 0 : step === 2 ? view.settings.privacy === 'local' || hasWorkingModel(view) : true;

  const next = async () => {
    if (step === 1) {
      const ok = await run(async () => {
        const r = await glossly.invoke('settings:set', { key: 'identity', value: { ...identity, name: identity.name.trim() } });
        if (r.error) throw new Error(r.error);
        return true;
      });
      if (!ok) return;
    }
    setStep(step + 1);
  };

  const finish = async () => {
    const ok = await run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'firstRunComplete', value: true });
      if (r.error) throw new Error(r.error);
      if (view.embed.state === 'not_downloaded') await glossly.invoke('embed:download');
      return true;
    });
    if (ok) onDone();
  };

  return (
    <div className="setup">
      <ol className="stepper" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'current' : i < step ? 'done' : undefined}>
            {s}
          </li>
        ))}
      </ol>
      <div className="setup-body">
        {step === 0 && <Welcome view={view} />}
        {step === 1 && <You identity={identity} onChange={setIdentity} />}
        {step === 2 && <Keys view={view} />}
        {step === 3 && <Models view={view} />}
        {step === 4 && <TryIt view={view} />}
      </div>
      <div className="setup-foot">
        {step > 0 && (
          <button onClick={() => setStep(step - 1)} disabled={busy}>
            Back
          </button>
        )}
        {error && <span className="error small">{error}</span>}
        {view.embed.state !== 'not_downloaded' && (
          <span className="muted small">
            Embeddings: <EmbedLine embed={view.embed} />
          </span>
        )}
        <span className="spacer" />
        {step === 1 && !canNext && <span className="muted small">Type your name to continue.</span>}
        {step === 2 && !canNext && <span className="muted small">Add a working key or a local model to continue.</span>}
        <button className="primary" disabled={!canNext || busy} onClick={() => void (last ? finish() : next())}>
          {last ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}
