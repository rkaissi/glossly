import { useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { CatalogModel, ModelRef, ModelsRefreshResult, RoleName, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { MenuList, type MenuItem } from '../controls/Menu';
import { Popover } from '../controls/Popover';
import { Select } from '../controls/Select';
import { Embeddings } from './Data';
import { ProviderList } from './Providers';
import { capabilityBadges, groupByProvider, matchModels, modelHint, providerOrder, roleWarning } from './format';
import { useAction } from './useAction';

const ROLES: { role: RoleName; label: string; desc: string }[] = [
  { role: 'chat', label: 'Chat', desc: 'Ask, Reply, and summaries. Use your best writer.' },
  { role: 'fast', label: 'Fast', desc: 'Who is this, Tasks, Visualize, and saving.' },
  { role: 'decision', label: 'Decision', desc: 'Suggests actions when the bar opens. Use a small, quick model.' },
];

const ACTION_OVERRIDES: { action: string; label: string; role: RoleName }[] = [
  { action: 'ask', label: 'Ask', role: 'chat' },
  { action: 'save_entities', label: 'Save: people and entity extraction', role: 'fast' },
  { action: 'router', label: 'Router decision', role: 'decision' },
];

/** Models shown per provider before searching: a gateway lists hundreds (decision 79). */
const PER_PROVIDER = 8;

function Badges({ m }: { m: CatalogModel }) {
  return (
    <span className="badges">
      {capabilityBadges(m).map((b) => (
        <span key={b.label} className={`tag${b.tone ? ` ${b.tone}` : ''}`} title={b.tone === 'measured' ? 'Measured from your own calls' : undefined}>
          {b.label}
        </span>
      ))}
    </span>
  );
}

/**
 * A model picker grouped by provider, with a search box (decision 79). Without a search each
 * provider shows its first few models (known ones first) and how many more there are.
 * `nullLabel` adds a "none" choice.
 */
export function ModelSelect(props: {
  view: SettingsView;
  value: ModelRef | null;
  nullLabel?: string;
  disabled?: boolean;
  label: string;
  onChange: (v: ModelRef | null) => void;
}) {
  const { view, value } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const order = providerOrder(view);
  const labelOf = (p: string) => order.find((o) => o.provider === p)?.label ?? p;
  const current = view.models.find((m) => m.ref === value);

  const close = (restore: boolean) => {
    setOpen(false);
    setQuery('');
    if (restore) ref.current?.focus();
  };
  const pick = (v: string) => {
    close(true);
    if (v.startsWith('more:')) return;
    const next = v === '' ? null : v;
    if (next !== value) props.onChange(next);
  };

  const items: MenuItem<string>[] = [];
  if (open) {
    if (props.nullLabel !== undefined && !query) items.push({ value: '', label: props.nullLabel });
    if (value && !current && !query) items.push({ value, label: `${value} (not available)` });
    for (const g of groupByProvider(matchModels(view.models, query, labelOf), order)) {
      const shown = query ? g.models : g.models.slice(0, PER_PROVIDER);
      if (!query && current && current.provider === g.provider && !shown.includes(current)) shown.push(current);
      for (const m of shown) items.push({ value: m.ref, label: m.displayName, hint: modelHint(m), group: g.label });
      const more = g.models.length - shown.length;
      if (more > 0) items.push({ value: `more:${g.provider}`, label: `${more} more. Type to search.`, group: g.label, disabled: true });
    }
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="trigger model-trigger"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.disabled}
        data-control
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="trigger-value">
          {current ? (
            <>
              <span className="clip1">{current.displayName}</span>
              <span className="via">{labelOf(current.provider)}</span>
            </>
          ) : value ? (
            <span className="clip1">{`${value} (not available)`}</span>
          ) : props.nullLabel !== undefined ? (
            <span className="clip1">{props.nullLabel}</span>
          ) : (
            <span className="placeholder">{view.models.length ? 'Pick a model' : 'Add a provider first'}</span>
          )}
        </span>
        <ChevronDown className="trigger-chevron" size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <Popover anchor={ref} onClose={close} label={props.label} className="select-pop model-pop" scrolls>
          <label className="model-search">
            <Search size={14} strokeWidth={1.75} aria-hidden />
            <input
              ref={searchRef}
              data-autofocus
              placeholder="Search models"
              aria-label="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  e.currentTarget.closest('.popover')?.querySelector<HTMLElement>('.pop-menu')?.focus();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const first = items.find((i) => !i.disabled);
                  if (first) pick(first.value);
                }
              }}
            />
          </label>
          {items.length > 0 ? (
            <MenuList key={query} items={items} selected={value ?? ''} checks autoFocus={false} noInitialActive label={props.label} onPick={pick} />
          ) : (
            <p className="model-none muted small">No model matches.</p>
          )}
        </Popover>
      )}
    </>
  );
}

function RoleRow({ view, role, label, desc }: { view: SettingsView; role: RoleName; label: string; desc: string }) {
  const { busy, error, run } = useAction();
  const cur = view.settings.roles[role];
  const set = (model: ModelRef | null, fallback: ModelRef | null) => void run(() => glossly.invoke('roles:set', { role, model, fallback }));
  const chosen = view.models.find((m) => m.ref === cur.model);
  const usesFast = role === 'decision' && cur.model === null;
  const warning = roleWarning(role, chosen);
  return (
    <div className="role">
      <div className="role-name">
        <strong>{label}</strong>
        {cur.manual && <span className="tag">Picked by you</span>}
      </div>
      <p className="muted small">{desc}</p>
      <div className="role-pickers">
        <label>
          <span className="small muted">Model</span>
          <ModelSelect
            view={view}
            label={`${label} model`}
            value={cur.model}
            nullLabel={role === 'decision' ? 'Use Fast model' : undefined}
            disabled={busy || view.models.length === 0}
            onChange={(m) => set(m, cur.fallback)}
          />
        </label>
        {!usesFast && (
          <label>
            <span className="small muted">Fallback</span>
            <ModelSelect
              view={view}
              label={`${label} fallback`}
              value={cur.fallback}
              nullLabel="None"
              disabled={busy || view.models.length === 0 || !cur.model}
              onChange={(f) => set(cur.model, f)}
            />
          </label>
        )}
      </div>
      {warning && <p className="warn small">{warning}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The model Local only uses for every call whose role model isn't local. */
function LocalOnlyRow({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const local = view.models.filter((m) => m.provider === 'local');
  if (local.length === 0) return null;
  const cur = view.settings.local;
  return (
    <div className="role">
      <div className="role-name">
        <strong>Local only</strong>
        {cur.manual && <span className="tag">Picked by you</span>}
      </div>
      <p className="muted small">Used for everything while Local only is on.</p>
      <div className="role-pickers">
        <label>
          <span className="small muted">Model</span>
          <Select<string>
            label="Local only model"
            value={cur.model}
            disabled={busy}
            onChange={(model) => void run(() => glossly.invoke('local:model', { model }))}
            options={local.map((m) => ({ value: m.ref, label: m.displayName }))}
          />
        </label>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function RolePickers({ view }: { view: SettingsView }) {
  return (
    <div className="roles">
      {ROLES.map((r) => (
        <RoleRow key={r.role} view={view} {...r} />
      ))}
      <LocalOnlyRow view={view} />
    </div>
  );
}

function ActionOverrides({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const set = (action: string, ref: ModelRef | null) => {
    const next = { ...view.settings.actionModels };
    if (ref) next[action] = ref;
    else delete next[action];
    void run(async () => {
      const r = await glossly.invoke('settings:set', { key: 'actionModels', value: next });
      if (r.error) throw new Error(r.error);
    });
  };
  return (
    <details className="advanced">
      <summary>Use a different model for one action</summary>
      <div className="overrides">
        {ACTION_OVERRIDES.map((o) => (
          <label key={o.action} className="override">
            <span>{o.label}</span>
            <ModelSelect
              view={view}
              label={`${o.label} model`}
              value={view.settings.actionModels[o.action] ?? null}
              nullLabel={`Use the ${o.role[0]!.toUpperCase()}${o.role.slice(1)} role`}
              disabled={busy}
              onChange={(m) => set(o.action, m)}
            />
          </label>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
    </details>
  );
}

function Catalog({ view }: { view: SettingsView }) {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<ModelsRefreshResult | null>(null);
  const [query, setQuery] = useState('');
  const r = view.settings.roles;
  const order = providerOrder(view);
  const labelOf = (p: string) => order.find((o) => o.provider === p)?.label ?? p;
  const usedBy = (ref: ModelRef) =>
    ROLES.flatMap(({ role, label }) => [r[role].model === ref && label, r[role].fallback === ref && `${label} fallback`]).filter(
      (x): x is string => Boolean(x),
    );
  const refresh = async () => {
    const res = await run(() => glossly.invoke('models:refresh'));
    if (res) setResult(res);
  };
  const groups = groupByProvider(matchModels(view.models, query, labelOf), order);
  return (
    <>
      <div className="row">
        <input className="grow" placeholder="Search models" aria-label="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="muted small">Speed with a dashed border is measured from your own calls. Untested models are never picked for you.</p>
      {error && <p className="error small">{error}</p>}
      {result?.errors.map((e) => (
        <p key={e.provider} className="error small">
          {labelOf(e.provider)}: {e.message}
        </p>
      ))}
      {result?.notices.map((n) => (
        <p key={n} className="warn small">
          {n}
        </p>
      ))}
      {view.models.length === 0 && <p className="muted">No models yet. Add a provider above.</p>}
      {groups.map((g) => (
        <div key={g.provider} className="catalog">
          <h4>
            {g.label} <span className="muted small">{g.models.length} models</span>
          </h4>
          <ul>
            {g.models.map((m) => (
              <li key={m.ref}>
                <span className="model-name" title={m.ref}>
                  {m.displayName}
                </span>
                <Badges m={m} />
                {usedBy(m.ref).map((u) => (
                  <span key={u} className="tag accent">
                    {u}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Providers, which model does what, and the embedding model (decision 79: providers are added from a list). */
export function ModelsTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>Models</h2>
      <p className="muted">Your keys are encrypted on this computer and only go to their own provider.</p>
      <ProviderList view={view} />
      <h3>Which model does what</h3>
      <p className="muted small">Glossly picks these for you. A model you choose stays.</p>
      <RolePickers view={view} />
      <ActionOverrides view={view} />
      <h3>On this computer</h3>
      <Embeddings view={view} />
      <details className="advanced">
        <summary>All available models ({view.models.length})</summary>
        <Catalog view={view} />
      </details>
    </section>
  );
}
