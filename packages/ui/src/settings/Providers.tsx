// Providers added from a list (decision 79; designed in docs/design/mockups/26-providers.html):
// the Models tab's list of added providers, the Add a provider dialog, and the form each
// provider needs, which setup's Connect step uses too.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, Braces, ChevronRight, ExternalLink, Laptop, Search, X } from 'lucide-react';
import type { ApiStyle, LocalFound, PresetInfo, ProviderStatus, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { Select } from '../controls/Select';
import { Modal } from './Modal';
import { localLabel, timeAgo } from './format';
import { useAction } from './useAction';
import './providers.css';

const GROUPS: { group: PresetInfo['group']; title: string }[] = [
  { group: 'free', title: 'Free to start' },
  { group: 'makers', title: 'Model makers' },
  { group: 'gateways', title: 'Gateways: one key, many makers' },
  { group: 'hosts', title: 'Open models, hosted' },
  { group: 'local', title: 'On this computer' },
  { group: 'custom', title: 'Anything else' },
];

/** Letter tiles stand in for logos: the app has no brand colors (decision 39). */
const LETTERS: Record<string, string> = {
  groq: 'G',
  google: 'Ge',
  openai: 'O',
  anthropic: 'A',
  xai: 'X',
  deepseek: 'D',
  moonshot: 'K',
  minimax: 'Mx',
  mistral: 'M',
  openrouter: 'OR',
  vercel: 'V',
  ramp: 'R',
  together: 'T',
  fireworks: 'F',
  baseten: 'B',
  ollama: 'Ol',
  lmstudio: 'LM',
};

const API_LABELS: Record<ApiStyle, string> = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
};

const VIA_NOTE = "Text goes to this service, and from there to the model's maker.";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ProviderMark({ preset, label }: { preset: string; label?: string }) {
  const icon = preset === 'local-other' || preset === 'local' ? <Laptop size={15} strokeWidth={1.75} aria-hidden /> : preset === 'custom' && !label ? <Braces size={15} strokeWidth={1.75} aria-hidden /> : null;
  return (
    <span className="mark" aria-hidden>
      {icon ?? LETTERS[preset] ?? (label ?? preset).slice(0, 1).toUpperCase()}
    </span>
  );
}

function presetTag(p: PresetInfo, found?: LocalFound): { label: string; accent?: boolean } | null {
  if (found?.running) return { label: 'Running', accent: true };
  if (p.free && p.group === 'free') return { label: 'Free tier' };
  if (p.group === 'gateways') return { label: 'Gateway' };
  if (p.group === 'hosts') return { label: 'Host' };
  return null;
}

/** The local presets running right now, looked up when `active` turns on. */
export function useLocalFound(active: boolean): LocalFound[] | null {
  const [found, setFound] = useState<LocalFound[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void glossly
      .invoke('local:detect')
      .then((r) => live && setFound(r))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, [active]);
  return found;
}

/** The hosted provider already added from this preset (Custom: never). */
const addedFrom = (view: SettingsView, preset: string) => (preset === 'custom' ? undefined : view.providers.find((p) => p.preset === preset));

/** The local server is at this preset's address. */
const localIs = (view: SettingsView, p: PresetInfo) => Boolean(p.baseUrl && view.local.baseUrl === p.baseUrl);

/** A preset that already works: added and tested, or the local server at its address. */
export function presetWorks(view: SettingsView, p: PresetInfo): boolean {
  if (p.group === 'local') return localIs(view, p) && Boolean(view.local.lastTest?.ok);
  return Boolean(addedFrom(view, p.id)?.lastTest?.ok);
}

// ---- the form each provider needs ----

/**
 * What a provider needs, and Test and save: a key; a name, address, way of talking, and maybe a
 * key (Custom); or nothing for a local server that's running. `existing` replaces the key or
 * address of one already added. Calls `onSaved` once it works.
 */
export function ProviderForm({
  view,
  preset,
  existing,
  found,
  onSaved,
  onCancel,
}: {
  view: SettingsView;
  preset: PresetInfo;
  existing?: ProviderStatus;
  found?: LocalFound[] | null;
  onSaved: (id: string) => void;
  onCancel?: () => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState(existing?.label ?? '');
  const [address, setAddress] = useState(existing?.baseUrl ?? '');
  const [api, setApi] = useState<ApiStyle | 'auto'>(existing?.api ?? 'auto');
  const { busy, error, setError, run } = useAction();

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const r = await run(() =>
      glossly.invoke('providers:add', {
        preset: preset.id,
        ...(existing && { id: existing.id }),
        ...(key.trim() && { key: key.trim() }),
        ...(preset.id === 'custom' && { label: name.trim(), baseUrl: address.trim(), ...(api !== 'auto' && { api }) }),
      }),
    );
    if (!r) return;
    if (r.ok && r.id) onSaved(r.id);
    else setError(r.error ?? 'That did not work.');
  };
  const connectLocal = async (baseUrl: string) => {
    const r = await run(() => glossly.invoke('local:connect', { baseUrl }));
    if (!r) return;
    if (r.ok) onSaved('local');
    else setError(r.error ?? 'Could not connect.');
  };

  const cancel = onCancel && (
    <button type="button" onClick={onCancel}>
      Cancel
    </button>
  );
  const keyLink = preset.keyUrl && (
    <a href={preset.keyUrl} target="_blank" rel="noreferrer">
      {preset.group === 'local' ? `Get ${preset.label}` : preset.free ? 'Get a free key' : 'Get a key'}
      <ExternalLink size={12} strokeWidth={2} aria-hidden />
    </a>
  );
  const replacesLocal = preset.group === 'local' && view.local.baseUrl && !localIs(view, preset) && (
    <p className="muted small">This replaces {localLabel(view)} as the local server: Glossly uses one at a time.</p>
  );

  if (preset.group === 'local' && preset.baseUrl) {
    const f = found?.find((x) => x.preset === preset.id);
    return (
      <div className="provider-form">
        {!found ? (
          <p className="muted small">Looking for {preset.label} on this computer…</p>
        ) : f?.running ? (
          <p className="found">
            <span className="dot" />
            {preset.label} is running at <code>{preset.baseUrl}</code> with {plural(f.models, 'model')}.
          </p>
        ) : (
          <p className="callout">
            {preset.label} isn't running at <code>{preset.baseUrl}</code>. Open it{preset.id === 'lmstudio' ? ' and start its server' : ''}, then try again.
          </p>
        )}
        {replacesLocal}
        <div className="row">
          <button type="button" className="primary" disabled={busy || !found} onClick={() => void connectLocal(preset.baseUrl!)}>
            {busy ? 'Connecting…' : f?.running ? 'Connect' : 'Try again'}
          </button>
          {cancel}
          <span className="spacer" />
          {!f?.running && keyLink}
        </div>
        {error && <p className="error small">{error}</p>}
        <p className="callout">Local only uses this for everything. It's slower than a hosted model.</p>
      </div>
    );
  }

  if (preset.group === 'local')
    return (
      <form
        className="provider-form"
        onSubmit={(e) => {
          e.preventDefault();
          void connectLocal(address);
        }}
      >
        <div className="field-big">
          <label htmlFor="provider-address">Address on this computer</label>
          <div className="keyline">
            <input id="provider-address" data-autofocus autoFocus placeholder="http://localhost:8080/v1" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
            <button type="submit" className="primary" disabled={busy || !address.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            {cancel}
          </div>
        </div>
        {replacesLocal}
        {error && <p className="error small">{error}</p>}
        <p className="callout">Local only uses this for everything. It's slower than a hosted model.</p>
      </form>
    );

  if (preset.id === 'custom')
    return (
      <form className="provider-form" onSubmit={(e) => void save(e)}>
        <div className="field-big">
          <label htmlFor="provider-name">Name</label>
          <input id="provider-name" data-autofocus autoFocus placeholder="Work gateway" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field-big">
          <label htmlFor="provider-address">Address</label>
          <input id="provider-address" placeholder="https://llm.example.com/v1" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="field-big">
          <label>Speaks</label>
          <Select<ApiStyle | 'auto'>
            label="How it talks"
            value={api}
            onChange={setApi}
            options={[
              { value: 'auto', label: 'Find out when testing' },
              { value: 'chat', label: 'OpenAI Chat Completions (most)' },
              { value: 'responses', label: API_LABELS.responses },
              { value: 'anthropic', label: API_LABELS.anthropic },
            ]}
          />
        </div>
        <div className="field-big">
          <label htmlFor="provider-key">
            <span>
              API key <span className="muted">{existing?.hasKey ? '(leave empty to keep the saved one)' : '(if it needs one)'}</span>
            </span>
          </label>
          <div className="keyline">
            <input id="provider-key" type="password" placeholder="Paste the key" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
            <button type="submit" className="primary" disabled={busy || !address.trim()}>
              {busy ? 'Testing…' : 'Test and save'}
            </button>
            {cancel}
          </div>
        </div>
        {error && <p className="error small">{error}</p>}
        <p className="callout">{VIA_NOTE} Glossly fills your roles only with models it knows, and you can pick any of the others yourself.</p>
      </form>
    );

  return (
    <form className="provider-form" onSubmit={(e) => void save(e)}>
      <div className="field-big">
        <label htmlFor={`provider-key-${preset.id}`}>
          <span>{preset.label} API key</span>
          {keyLink}
        </label>
        <div className="keyline">
          <input
            id={`provider-key-${preset.id}`}
            data-autofocus
            autoFocus
            type="password"
            placeholder={preset.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !key.trim()}>
            {busy ? 'Testing…' : 'Test and save'}
          </button>
          {cancel}
        </div>
      </div>
      {error ? (
        <p className="error small">{error}</p>
      ) : existing?.lastTest && !existing.lastTest.ok ? (
        <p className="error small">The saved key failed its last test: {existing.lastTest.error ?? 'unknown error'}</p>
      ) : null}
      {preset.via && <p className="callout">{VIA_NOTE} Glossly fills your roles only with models it knows, and you can pick any of the others yourself.</p>}
    </form>
  );
}

// ---- the Add a provider dialog ----

/**
 * Every preset, grouped and searchable. In Settings, picking one shows its form here and the
 * dialog closes once it works; in setup (`onPick`), picking closes it and setup shows the form.
 */
export function AddProviderDialog({
  view,
  onClose,
  onPick,
  isTaken,
}: {
  view: SettingsView;
  onClose: () => void;
  onPick?: (preset: string) => void;
  /** Shown as "Added" and not offered again. Default: added already, or the local server's address. */
  isTaken?: (p: PresetInfo) => boolean;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PresetInfo | null>(null);
  const found = useLocalFound(true);
  const taken = isTaken ?? ((p: PresetInfo) => (p.group === 'local' ? localIs(view, p) : Boolean(addedFrom(view, p.id))));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = view.presets.filter((p) => words.every((w) => `${p.label} ${p.blurb} ${presetTag(p)?.label ?? ''}`.toLowerCase().includes(w)));

  const pick = (p: PresetInfo) => {
    if (onPick) {
      onClose();
      onPick(p.id);
    } else setPicked(p);
  };

  return (
    <Modal label={picked ? `Add ${picked.label}` : 'Add a provider'} onClose={onClose}>
      {picked ? (
        <>
          <div className="modal-head">
            <button type="button" className="icon-btn" aria-label="Back to the list" onClick={() => setPicked(null)}>
              <ArrowLeft size={16} strokeWidth={1.75} />
            </button>
            <h3>{picked.label}</h3>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
          <p className="muted small">{picked.blurb}</p>
          <ProviderForm view={view} preset={picked} found={found} onSaved={onClose} />
        </>
      ) : (
        <>
          <div className="modal-head">
            <h3>Add a provider</h3>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
          <label className="preset-search">
            <Search size={14} strokeWidth={1.75} aria-hidden />
            <input data-autofocus placeholder="Search providers" aria-label="Search providers" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {GROUPS.map(({ group, title }) => {
            const ps = shown.filter((p) => p.group === group);
            if (ps.length === 0) return null;
            return (
              <section key={group} className="preset-group">
                <h4>{title}</h4>
                <div className="preset-tiles">
                  {ps.map((p) => {
                    const isTaken = p.id !== 'custom' && taken(p);
                    const tag = isTaken ? { label: 'Added' } : presetTag(p, found?.find((f) => f.preset === p.id));
                    return (
                      <button key={p.id} type="button" className="preset-tile" disabled={isTaken} onClick={() => pick(p)}>
                        <ProviderMark preset={p.id} />
                        <span className="preset-text">
                          <strong>
                            {p.label}
                            {tag && <span className={`tag${tag.accent ? ' accent' : ''}`}>{tag.label}</span>}
                          </strong>
                          <span>{p.blurb}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {shown.length === 0 && <p className="muted small">No provider by that name. Use Custom with its address.</p>}
        </>
      )}
    </Modal>
  );
}

// ---- the list in the Models tab ----

/** Which roles and actions use a provider's models, for a row's "Used for". */
function usedFor(view: SettingsView, provider: string): string {
  const of = (ref: string | null) => ref !== null && ref.slice(0, ref.indexOf(':')) === provider;
  const r = view.settings.roles;
  const names = { chat: 'Chat', fast: 'Fast', decision: 'Decision' } as const;
  const out: string[] = [];
  for (const role of ['chat', 'fast', 'decision'] as const) {
    if (of(r[role].model)) out.push(names[role]);
    else if (of(r[role].fallback)) out.push(`${names[role]} fallback`);
  }
  if (Object.values(view.settings.actionModels).some(of)) out.push('one action');
  if (provider === 'local' && view.settings.local.model) out.push('Local only');
  return out.length ? out.join(', ') : 'Nothing yet';
}

function Status({ test, models }: { test: ProviderStatus['lastTest']; models?: number }) {
  if (test?.ok)
    return (
      <span className="pstatus">
        <span className="dot" />
        Working · {plural(models ?? test.models, 'model')} · tested {timeAgo(test.at)}
      </span>
    );
  if (test)
    return (
      <span className="pstatus error">
        <span className="dot bad" />
        Last test failed: {test.error ?? 'unknown error'}
      </span>
    );
  return (
    <span className="pstatus">
      <span className="dot idle" />
      Saved, not tested yet
    </span>
  );
}

function ProviderRow({ view, p }: { view: SettingsView; p: ProviderStatus }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const preset = view.presets.find((x) => x.id === p.preset);
  const tag = p.preset === 'custom' ? 'Custom' : preset ? presetTag(preset)?.label : null;
  return (
    <div className={`prow${open ? ' open' : ''}`}>
      <button type="button" className="prow-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ProviderMark preset={p.preset} label={p.preset === 'custom' ? p.label : undefined} />
        <span className="prow-main">
          <span className="prow-name">
            {p.label}
            {tag && <span className="tag">{tag}</span>}
          </span>
          <Status test={p.lastTest} />
        </span>
        <ChevronRight className="chev" size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className="prow-body">
          <dl className="kv">
            {p.preset !== 'custom' || p.hasKey ? (
              <>
                <dt>Key</dt>
                <dd>{p.hasKey ? 'Saved, encrypted on this computer' : 'None'}</dd>
              </>
            ) : null}
            {p.baseUrl && (
              <>
                <dt>Address</dt>
                <dd>
                  <code>{p.baseUrl}</code>
                </dd>
              </>
            )}
            {p.api && (
              <>
                <dt>Speaks</dt>
                <dd>{API_LABELS[p.api]}</dd>
              </>
            )}
            <dt>Used for</dt>
            <dd>{usedFor(view, p.id)}</dd>
          </dl>
          {p.via && <p className="muted small">{VIA_NOTE}</p>}
          {editing && preset ? (
            <ProviderForm view={view} preset={preset} existing={p} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
          ) : (
            <div className="row">
              <button disabled={busy} onClick={() => void run(() => glossly.invoke('providers:test', { id: p.id }))}>
                {busy ? 'Testing…' : 'Test again'}
              </button>
              <button disabled={busy} onClick={() => setEditing(true)}>
                {p.preset === 'custom' ? 'Change' : 'Replace key'}
              </button>
              {confirming ? (
                <InlineConfirm
                  prompt={`Remove ${p.label}?`}
                  confirm="Remove"
                  busy={busy}
                  onConfirm={() => void run(() => glossly.invoke('providers:remove', { id: p.id }))}
                  onCancel={() => setConfirming(false)}
                />
              ) : (
                <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>
                  Remove
                </button>
              )}
            </div>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** The local server, as a row like the others. */
function LocalRow({ view }: { view: SettingsView }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const { baseUrl, loopback, lastTest } = view.local;
  const local = view.local.presets.find((p) => p.baseUrl === baseUrl);
  const preset = view.presets.find((p) => p.id === (local?.id ?? 'local-other'))!;
  return (
    <div className={`prow${open ? ' open' : ''}`}>
      <button type="button" className="prow-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ProviderMark preset={local?.id ?? 'local'} />
        <span className="prow-main">
          <span className="prow-name">
            {localLabel(view)}
            <span className="tag">This computer</span>
          </span>
          <Status test={lastTest} />
        </span>
        <ChevronRight className="chev" size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className="prow-body">
          <dl className="kv">
            <dt>Address</dt>
            <dd>
              <code>{baseUrl}</code>
            </dd>
            <dt>Used for</dt>
            <dd>{usedFor(view, 'local')}</dd>
          </dl>
          {!loopback && <p className="warn small">This address is on another computer, so Local only won't use it.</p>}
          {editing ? (
            <ProviderForm view={view} preset={view.presets.find((p) => p.id === 'local-other') ?? preset} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
          ) : (
            <div className="row">
              <button disabled={busy} onClick={() => void run(() => glossly.invoke('local:test'))}>
                {busy ? 'Testing…' : 'Test again'}
              </button>
              <button disabled={busy} onClick={() => setEditing(true)}>
                Change address
              </button>
              {confirming ? (
                <InlineConfirm
                  prompt="Forget the local server?"
                  confirm="Remove"
                  busy={busy}
                  onConfirm={() => void run(() => glossly.invoke('local:remove'))}
                  onCancel={() => setConfirming(false)}
                />
              ) : (
                <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>
                  Remove
                </button>
              )}
            </div>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** The providers added, the local server last, and Add provider. */
export function ProviderList({ view }: { view: SettingsView }) {
  const [adding, setAdding] = useState(false);
  const empty = view.providers.length === 0 && !view.local.baseUrl;
  const rows = useMemo(() => view.providers, [view.providers]);
  return (
    <>
      <div className="section-head">
        <h3>Providers</h3>
        <span className="spacer" />
        <button className="primary" onClick={() => setAdding(true)}>
          Add provider
        </button>
      </div>
      <div className="plist">
        {empty && <p className="plist-empty muted">No providers yet. Add one to start: Groq and Google Gemini have free tiers.</p>}
        {rows.map((p) => (
          <ProviderRow key={p.id} view={view} p={p} />
        ))}
        {view.local.baseUrl && <LocalRow view={view} />}
      </div>
      {adding && <AddProviderDialog view={view} onClose={() => setAdding(false)} />}
    </>
  );
}
