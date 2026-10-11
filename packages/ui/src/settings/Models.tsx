import { useState } from 'react';
import type { CatalogModel, ModelRef, ModelsRefreshResult, RoleName, SettingsView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { capabilityBadges, groupByProvider, roleWarning } from './format';
import { useAction } from './useAction';

const ROLES: { role: RoleName; label: string; desc: string }[] = [
  { role: 'fast', label: 'Fast', desc: 'Routing when no decision model is set, and finding people and dates when you save. Needs structured output.' },
  { role: 'chat', label: 'Chat', desc: 'Writes Ask answers. Pick the strongest writer you have.' },
  { role: 'decision', label: 'Decision', desc: 'Picks the extra actions in slots 3 and 4. Rules take over if it is slower than {timeout} ms.' },
];

const ACTION_OVERRIDES: { action: string; label: string; role: RoleName }[] = [
  { action: 'ask', label: 'Ask', role: 'chat' },
  { action: 'save_entities', label: 'Save: people and entity extraction', role: 'fast' },
  { action: 'router', label: 'Router decision', role: 'decision' },
];

const providerOrder = (view: SettingsView) => [...view.keys.map((k) => ({ provider: k.provider, label: k.label })), { provider: 'local', label: 'Local' }];

function Badges({ m }: { m: CatalogModel }) {
  return (
    <span className="badges">
      {capabilityBadges(m).map((b) => (
        <span key={b} className={`tag${b === 'Untested' ? ' warn' : ''}`}>
          {b}
        </span>
      ))}
    </span>
  );
}

/** A model dropdown grouped by provider. `nullLabel` adds a "none" choice. */
export function ModelSelect(props: {
  view: SettingsView;
  value: ModelRef | null;
  nullLabel?: string;
  disabled?: boolean;
  label: string;
  onChange: (v: ModelRef | null) => void;
}) {
  const { view, value } = props;
  const groups = groupByProvider(view.models, providerOrder(view));
  const missing = value && !view.models.some((m) => m.ref === value);
  return (
    <select
      aria-label={props.label}
      value={value ?? ''}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value === '' ? null : e.target.value)}
    >
      {props.nullLabel !== undefined ? (
        <option value="">{props.nullLabel}</option>
      ) : (
        value === null && (
          <option value="" disabled>
            {view.models.length ? 'Pick a model' : 'Add a key first'}
          </option>
        )
      )}
      {missing && <option value={value}>{value} (not available)</option>}
      {groups.map((g) => (
        <optgroup key={g.provider} label={g.label}>
          {g.models.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.displayName}
              {m.capabilities ? '' : ' (Untested)'}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
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
      <p className="muted small">{desc.replace('{timeout}', String(view.settings.router.decisionTimeoutMs))}</p>
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
            <span className="small muted">Fallback on rate limits or outages</span>
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
      {chosen && <Badges m={chosen} />}
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
      <p className="muted small">Used for every model call while Local only is on, unless a role above already uses a local model.</p>
      <div className="role-pickers">
        <label>
          <span className="small muted">Model</span>
          <select
            aria-label="Local only model"
            value={cur.model ?? ''}
            disabled={busy}
            onChange={(e) => void run(() => glossly.invoke('local:model', { model: e.target.value }))}
          >
            {local.map((m) => (
              <option key={m.ref} value={m.ref}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function RolePickers({ view }: { view: SettingsView }) {
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
      <summary>Advanced: a different model for one action</summary>
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
  const r = view.settings.roles;
  const usedBy = (ref: ModelRef) =>
    ROLES.flatMap(({ role, label }) => [r[role].model === ref && label, r[role].fallback === ref && `${label} fallback`]).filter(
      (x): x is string => Boolean(x),
    );
  const refresh = async () => {
    const res = await run(() => glossly.invoke('models:refresh'));
    if (res) setResult(res);
  };
  const groups = groupByProvider(view.models, providerOrder(view));
  return (
    <>
      <div className="row">
        <h3 className="grow">Available models</h3>
        <button disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {result?.errors.map((e) => (
        <p key={e.provider} className="error small">
          {e.provider}: {e.message}
        </p>
      ))}
      {result?.notices.map((n) => (
        <p key={n} className="warn small">
          {n}
        </p>
      ))}
      {groups.length === 0 && <p className="muted">No models yet. Add a key in the Keys tab.</p>}
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

export function ModelsTab({ view }: { view: SettingsView }) {
  return (
    <section>
      <h2>Models</h2>
      <p className="muted">Every model call belongs to a role. Defaults fill in when keys change; a model you pick by hand is never replaced.</p>
      <RolePickers view={view} />
      <ActionOverrides view={view} />
      <Catalog view={view} />
    </section>
  );
}
