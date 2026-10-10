import type { ModelRef, RoleAssignment, RoleName, Settings } from '../settings';
import { parseRef, pickDefault, type CatalogModel } from './catalog';

export interface RoleUpdate {
  roles: Settings['roles'];
  changed: boolean;
  /** One-line notices for the bar, e.g. a model the user picked went away. */
  notices: string[];
}

const ROLE_LABEL: Record<RoleName, string> = { fast: 'Fast', chat: 'Chat', decision: 'Decision' };

/** Best default from a different provider than `primary`, so a provider outage has a way out. */
function pickFallback(role: 'fast' | 'chat', models: CatalogModel[], primary: ModelRef | null): ModelRef | null {
  if (!primary) return null;
  const { provider } = parseRef(primary);
  const other = pickDefault(role, models.filter((m) => m.provider !== provider));
  if (other) return other.ref;
  const same = pickDefault(role, models.filter((m) => m.ref !== primary));
  return same?.ref ?? null;
}

/**
 * Called whenever keys or the model catalog change. Fills empty roles from the defaults in
 * capabilities.json, never overwrites a hand-picked role that is still available, and switches
 * a role whose model disappeared back to the default with a notice.
 */
export function updateRoles(current: Settings['roles'], models: CatalogModel[]): RoleUpdate {
  const available = new Set(models.map((m) => m.ref));
  const notices: string[] = [];
  const roles = structuredClone(current);

  for (const role of ['fast', 'chat'] as const) {
    const r: RoleAssignment = roles[role];
    if (r.model && !available.has(r.model)) {
      const def = pickDefault(role, models);
      notices.push(
        def
          ? `${ROLE_LABEL[role]} model ${parseRef(r.model).modelId} is no longer available. Switched to ${def.modelId}.`
          : `${ROLE_LABEL[role]} model ${parseRef(r.model).modelId} is no longer available. Add a key in Settings.`,
      );
      r.model = null;
      r.manual = false;
    }
    if (!r.model) {
      r.model = pickDefault(role, models)?.ref ?? null;
      r.manual = false;
    }
    if (r.fallback && (!available.has(r.fallback) || r.fallback === r.model)) r.fallback = null;
    if (!r.fallback && !r.manual) r.fallback = pickFallback(role, models, r.model);
  }

  const d = roles.decision;
  if (d.model && !available.has(d.model)) {
    notices.push(`Decision model ${parseRef(d.model).modelId} is no longer available. Using the Fast model.`);
    d.model = null;
    d.manual = false;
  }
  if (d.fallback && !available.has(d.fallback)) d.fallback = null;

  return { roles, changed: JSON.stringify(roles) !== JSON.stringify(current), notices };
}

/** The models to try for a call, in order: per-action override or role model, then fallback. */
export function modelChain(role: RoleName, settings: Pick<Settings, 'roles' | 'actionModels'>, action?: string): ModelRef[] {
  const chain: (ModelRef | null)[] = [];
  const override = action ? settings.actionModels[action] : undefined;
  if (override) chain.push(override);
  if (role === 'decision' && !settings.roles.decision.model) {
    chain.push(settings.roles.fast.model, settings.roles.decision.fallback ?? settings.roles.fast.fallback);
  } else {
    chain.push(settings.roles[role].model, settings.roles[role].fallback);
  }
  return [...new Set(chain.filter((m): m is ModelRef => Boolean(m)))];
}
