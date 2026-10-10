import { useEffect, useState } from 'react';
import type { SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { EmbedLine } from './Data';
import { formatAccelerator } from './format';
import { hasWorkingKey, KeyCard } from './Keys';
import { RolePickers } from './Models';
import { useAction } from './useAction';

const STEPS = ['Welcome', 'Keys', 'Models', 'Try it'] as const;

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
        <li>Ask a question about it, or save it to a collection with a note on why.</li>
      </ul>
      <div className="card">
        <h3>Privacy</h3>
        <ul className="small">
          <li>Glossly reads the text you select. It reads the text around it only when you open the bar or click an action.</li>
          <li>It never records keystrokes; the hotkey is its only keyboard shortcut. Password fields and password managers are never read.</li>
          <li>
            Everything is stored on this computer. Selected text goes only to the provider whose key you add: when the bar opens, to pick actions (turn on
            Local only in Settings to stop this), and when you click Ask or Save.
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

function Keys({ view }: { view: SettingsView }) {
  return (
    <>
      <h1>Add a model key</h1>
      <p className="muted">
        Glossly uses your own API keys and has no server. Groq has a free tier that needs no card, so it is the easiest place to start. You need at least
        one working key.
      </p>
      {view.keys.map((k) => (
        <KeyCard key={k.provider} k={k} />
      ))}
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
  const { busy, error, run } = useAction();
  const last = step === STEPS.length - 1;
  const canNext = step !== 1 || hasWorkingKey(view);

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
        {step === 1 && <Keys view={view} />}
        {step === 2 && <Models view={view} />}
        {step === 3 && <TryIt view={view} />}
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
        {step === 1 && !canNext && <span className="muted small">Add a working key to continue.</span>}
        <button className="primary" disabled={!canNext || busy} onClick={() => (last ? void finish() : setStep(step + 1))}>
          {last ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}
