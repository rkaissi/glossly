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

const emptyRole: RoleAssignment = { model: null, fallback: null, manual: false };

/**
 * Every user-tunable value. Stored one key per row in the `settings` table. Model names,
 * thresholds, and timings live here, never in code.
 */
export const SettingsSchema = z.object({
  firstRunComplete: z.boolean().default(false),
  /** Electron accelerator syntax. */
  hotkey: z.string().default('Control+Alt+Space'),
  localOnly: z.boolean().default(false),
  debugView: z.boolean().default(true),

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
      minWords: z.number().int().min(1).default(3),
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
      decisionTimeoutMs: z.number().int().min(50).default(400),
    })
    .prefault({}),

  roles: z
    .object({
      fast: RoleAssignmentSchema.default(emptyRole),
      chat: RoleAssignmentSchema.default(emptyRole),
      /** model null means "Use Fast model". */
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

  embeddings: z
    .object({
      model: z.string().default('Xenova/all-MiniLM-L6-v2'),
      dims: z.number().int().default(384),
    })
    .prefault({}),

  /** Notices shown once in the bar, e.g. a role's model disappeared. */
  pendingNotice: z.string().nullable().default(null),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export const DEFAULT_COLLECTIONS = ['Notes', 'Reading', 'Ideas', 'People notes'] as const;

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
