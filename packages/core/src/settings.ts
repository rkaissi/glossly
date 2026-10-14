import { z } from 'zod';

export const AppModeSchema = z.enum(['auto', 'hotkey', 'off']);
export type AppMode = z.infer<typeof AppModeSchema>;

export const RoleNameSchema = z.enum(['fast', 'chat', 'decision']);
export type RoleName = z.infer<typeof RoleNameSchema>;

/** "provider:modelId", e.g. "groq:llama-3.1-8b-instant". */
export const ModelRefSchema = z.string().regex(/^[a-z0-9_-]+:.+$/);
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const RoleAssignmentSchema = z.object({
  model: ModelRefSchema.nullable(),
  fallback: ModelRefSchema.nullable(),
  /** Set when the user picked the model by hand; defaults never overwrite it. */
  manual: z.boolean(),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const PrivacySchema = z.enum(['all', 'local']);
export type Privacy = z.infer<typeof PrivacySchema>;

const emptyRole: RoleAssignment = { model: null, fallback: null, manual: false };

/**
 * Who the user is (spec: People layer, User identity): used to tell "me" from "them" in
 * messages, commitments, and replies. Entered at first run and in the Profile tab.
 */
export const IdentitySchema = z.object({
  name: z.string().max(100).default(''),
  emails: z.array(z.string().max(200)).max(10).default([]),
  /** Chat handles and display names, stored without a leading "@". */
  handles: z.array(z.string().max(100)).max(10).default([]),
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * Every user-tunable value. Stored one key per row in the `settings` table. Model names,
 * thresholds, and timings live here, never in code.
 */
export const SettingsSchema = z.object({
  firstRunComplete: z.boolean().default(false),
  /** Electron accelerator syntax. */
  hotkey: z.string().default('Control+Alt+Space'),
  /**
   * Save mode (decision 15). manual: the Save button opens the Save panel. hotkey: the same,
   * plus `saveHotkey` saves the selection straight away. autosave: a highlight that shows the
   * pill is saved as it is captured, and the bar offers Undo instead of Save.
   */
  saveMode: z.enum(['manual', 'hotkey', 'autosave']).default('manual'),
  /** Registered only in the "hotkey" Save mode. */
  saveHotkey: z.string().default('Control+Alt+S'),
  /**
   * Where model calls may go (decision 34). all: any configured provider, cloud or local.
   * local: nothing leaves this computer; calls go to a local model on a loopback address, or
   * are refused (decision 12). A third choice (a subscription) may join later.
   */
  privacy: PrivacySchema.default('all'),
  /**
   * The local model server (Ollama, LM Studio, or any OpenAI-compatible endpoint). baseUrl null
   * means none is set up. `model` is what Local only uses for any call whose role model isn't
   * local; filled from the local catalog, never overwritten while it stays available once
   * picked by hand (`manual`).
   */
  local: z
    .object({
      baseUrl: z.string().url().nullable().default(null),
      model: ModelRefSchema.nullable().default(null),
      manual: z.boolean().default(false),
    })
    .prefault({}),
  /** Reply learns from the drafts the user picks and edits (Profile). Off: nothing is recorded or used. */
  replyLearning: z.boolean().default(true),
  /**
   * Keep every model call's prompt, answer, model, and timing in the local `llm_calls` table for
   * 30 days, to debug what the models saw (decision 61). Off by default; turning it off deletes the log.
   */
  callLog: z.boolean().default(false),
  /** The debug block under the bar. Off for new profiles (Step 21): testers shouldn't start with it. */
  debugView: z.boolean().default(false),
  identity: IdentitySchema.prefault({}),

  /** Keys are process names ("slack.exe") or window-title suffixes ("- Google Docs"). */
  appModes: z.record(z.string(), AppModeSchema).default({}),
  /** Extra entries on top of the built-in block list. Same key format as appModes. */
  blockList: z.array(z.string()).default([]),
  /**
   * Learned on this machine: apps and sites (same key format as appModes) where a selection
   * toolbar appeared, with the latest ms after mouse-up it was first seen. No text.
   */
  toolbarWaits: z.record(z.string(), z.number().int().min(0)).default({}),

  capture: z
    .object({
      minWords: z.number().int().min(0).default(0),
      /** The full wait for a selection toolbar, in apps known or learned to show one. From mouse-up. */
      pillDelayMs: z.number().int().min(0).default(250),
      /** The wait everywhere else. */
      shortWaitMs: z.number().int().min(0).default(100),
      /** When the first toolbar check runs, and how often after that until the wait is over. */
      pollStartMs: z.number().int().min(0).default(100),
      pollIntervalMs: z.number().int().min(10).default(35),
      hideDistancePx: z.number().int().min(20).default(200),
      contextChars: z.number().int().min(0).default(500),
      containerChars: z.number().int().min(500).default(8000),
      copyTimeoutMs: z.number().int().min(20).default(120),
    })
    .prefault({}),

  router: z
    .object({
      slotThreshold: z.number().min(0).max(1).default(0.5),
      moreThreshold: z.number().min(0).max(1).default(0.2),
      decisionTimeoutMs: z.number().int().min(50).default(600),
      /** The budget once the router's call has moved to its fallback model (after a 429 or 5xx, or one remembered; decision 60). */
      fallbackTimeoutMs: z.number().int().min(50).default(900),
    })
    .prefault({}),

  roles: z
    .object({
      fast: RoleAssignmentSchema.default(emptyRole),
      chat: RoleAssignmentSchema.default(emptyRole),
      /** Filled automatically with the fastest model (decision 60); model null ("Use Fast model") only when picked by hand. */
      decision: RoleAssignmentSchema.default(emptyRole),
    })
    .prefault({}),
  /** Per-action model override (Advanced), e.g. { ask: "anthropic:claude-sonnet-5-5" }. */
  actionModels: z.record(z.string(), ModelRefSchema).default({}),

  save: z
    .object({
      undoSeconds: z.number().int().min(1).default(10),
      excerptChars: z.number().int().min(0).default(1000),
    })
    .prefault({}),

  ask: z
    .object({
      defaultQuestion: z.string().default('Explain this briefly.'),
    })
    .prefault({}),

  recall: z
    .object({
      /** Cosine similarity a saved item needs to count as related (spec: Recall). */
      // 0.78 was out of reach for all-MiniLM-L6-v2: related notes score about 0.4 to 0.75 and unrelated
      // ones under 0.35 (Step 21's Recall eval), so similar-topic recall never fired. Decision 67.
      minSimilarity: z.number().min(0).max(1).default(0.5),
      /** Lower bar for the search box, where the user asked for it. */
      searchSimilarity: z.number().min(0).max(1).default(0.45),
      maxResults: z.number().int().min(1).max(20).default(5),
    })
    .prefault({}),

  paste: z
    .object({
      /** How many recent snippets the paste actions use, and how far back they look. */
      recentCount: z.number().int().min(1).max(50).default(10),
      recentDays: z.number().int().min(1).max(90).default(7),
      /** With text around the caret, saved items at least this close in meaning are pasted, whatever their age. */
      relatedSimilarity: z.number().min(0).max(1).default(0.4),
    })
    .prefault({}),

  embeddings: z
    .object({
      model: z.string().default('Xenova/all-MiniLM-L6-v2'),
      dims: z.number().int().default(384),
    })
    .prefault({}),

  /** Local hour when a commitment's due-date notification is shown (spec: 9:00). */
  reminderHour: z.number().int().min(0).max(23).default(9),
  /** When the bar shows each action's key in a chip (decision 41): always, only on a bar opened with the hotkey (the default), or never. The keys work either way. */
  keyHints: z.enum(['always', 'hotkey', 'never']).default('hotkey'),
  /** First day of the week in the calendar and date pickers: 1 Monday (the default), 0 Sunday. */
  weekStart: z.union([z.literal(0), z.literal(1)]).default(1),
  /** The Calendar tab's last view, which it opens on next time (Week at first). */
  calendarView: z.enum(['month', 'week', 'agenda']).default('week'),
  /** Minutes before a timed calendar event its reminder shows; all-day events use `reminderHour`. */
  eventReminderMinutes: z.number().int().min(0).max(24 * 60).default(15),

  /** Start Glossly in the background when the user signs in to Windows (decision 71). Installed builds only. */
  openAtLogin: z.boolean().default(true),
  /** Download new versions in the background and offer "Restart to update" (decision 70); off, the user downloads them from Settings. */
  autoUpdate: z.boolean().default(true),

  /** Notices shown once in the bar, e.g. a role's model disappeared. */
  pendingNotice: z.string().nullable().default(null),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export const DEFAULT_COLLECTIONS = ['Notes', 'Reading', 'Ideas', 'People notes'] as const;

/**
 * One-time changes to stored values, applied in order and tracked in meta
 * `settings_migrations`. Settings are stored per key, so a changed default only reaches users
 * who still have the old default through one of these. Each returns the new value for its key,
 * or undefined to leave it.
 */
export const SETTINGS_MIGRATIONS: {
  key: SettingsKey;
  /** Read this stored key instead of `key`, write the result to `key`, and delete `from` (a renamed setting). */
  from?: string;
  migrate: (stored: unknown) => unknown;
}[] = [
  // Oct 10: the router's decision budget went from 400 to 600 ms (400 timed out too often).
  {
    key: 'router',
    migrate: (r) =>
      r && typeof r === 'object' && (r as { decisionTimeoutMs?: unknown }).decisionTimeoutMs === 400 ? { ...r, decisionTimeoutMs: 600 } : undefined,
  },
  // Oct 10: the auto pill no longer requires 3 words. A stored 3 (the old default) becomes 0; any other value stays.
  {
    key: 'capture',
    migrate: (c) =>
      c && typeof c === 'object' && (c as { minWords?: unknown }).minWords === 3 ? { ...c, minWords: 0 } : undefined,
  },
  // Oct 11: "Don't show here" stores the site's plain name ("Discord", "Google Docs") instead of a
  // title key ("Discord |", "- Google Docs", "| Medium"). Rename stored title keys; a name already
  // present wins. Process keys ("slack.exe") stay.
  {
    key: 'appModes',
    migrate: (m) => {
      if (!m || typeof m !== 'object') return undefined;
      const entries = Object.entries(m as Record<string, unknown>);
      const isTitle = (k: string) => /^[-—–|]/.test(k.trim()) || /\s\|$/.test(k.trim());
      if (!entries.some(([k]) => isTitle(k))) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, v] of entries) if (!isTitle(k)) out[k] = v;
      for (const [k, v] of entries) {
        if (!isTitle(k)) continue;
        const name = k.trim().replace(/^[-—–|]\s*/, '').replace(/\s*\|$/, '');
        if (name && !(name in out)) out[name] = v;
      }
      return out;
    },
  },
  // Oct 11: the Local only checkbox became a choice (decision 34): localOnly true → privacy "local".
  { key: 'privacy', from: 'localOnly', migrate: (v) => (v === true ? 'local' : 'all') },
  // Oct 13: Recall's similarity floor went from 0.78 to 0.5 (decision 67). A stored 0.78 (the old default) moves; any other value stays.
  {
    key: 'recall',
    migrate: (r) =>
      r && typeof r === 'object' && (r as { minSimilarity?: unknown }).minSimilarity === 0.78 ? { ...r, minSimilarity: 0.5 } : undefined,
  },
];

/** Parses a partial or stale stored object, keeping valid keys and defaulting the rest. */
export function parseSettings(raw: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = {};
  const shape = SettingsSchema.shape;
  for (const key of Object.keys(shape) as SettingsKey[]) {
    const r = shape[key].safeParse(raw[key]);
    out[key] = r.success ? r.data : shape[key].parse(undefined);
  }
  return out as Settings;
}
