import { z } from 'zod';

// Machine-readable version of helpers/protocol.md. Both native helpers must satisfy these.

export const RectSchema = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unknown_command',
  'no_selection',
  'password_field',
  'no_foreground',
  'window_gone',
  'focus_failed',
  'clipboard_busy',
  'hook_failed',
  'internal',
]);
export type HelperErrorCode = z.infer<typeof ErrorCodeSchema>;

const Enabled = z.object({ enabled: z.boolean() });

const PopupSchema = z.object({
  source: z.enum(['window', 'uia']),
  kind: z.enum(['popup_window', 'tool_window', 'toolbar', 'menu', 'tooltip']),
  bounds: RectSchema,
  id: z.string(),
  class_name: z.string(),
  process_name: z.string(),
});

export const Commands = {
  ping: {
    args: z.object({}),
    result: z.object({ pong: z.literal(true), version: z.string(), protocol: z.number().int() }),
  },
  selection: {
    args: z.object({ max_chars: z.number().int().optional() }),
    result: z.object({
      text: z.string(),
      method: z.enum(['uia', 'ax']),
      bounds: RectSchema.nullable(),
      is_editable: z.boolean(),
      is_password: z.boolean(),
      control_type: z.string(),
      truncated: z.boolean(),
    }),
  },
  context: {
    args: z.object({ before: z.number().int().optional(), after: z.number().int().optional() }),
    result: z.object({ before: z.string(), after: z.string() }),
  },
  context_container: {
    args: z.object({ max_chars: z.number().int().optional() }),
    result: z.object({
      text: z.string(),
      selection_start: z.number().int().nonnegative(),
      selection_length: z.number().int().nonnegative(),
      source: z.enum(['container', 'tier1']),
      container_type: z.string(),
    }),
  },
  foreground: {
    args: z.object({}),
    result: z.object({
      handle: z.number().int(),
      pid: z.number().int(),
      process_name: z.string(),
      title: z.string(),
      class_name: z.string(),
    }),
  },
  popups_near: {
    args: z.object({
      bounds: RectSchema,
      exclude_pids: z.array(z.number().int()).optional(),
      all_windows: z.boolean().optional(),
    }),
    result: z.object({ popups: z.array(PopupSchema) }),
  },
  baseline: {
    args: z.object({ exclude_pids: z.array(z.number().int()).optional(), wait_ms: z.number().int().optional() }),
    result: z.object({
      available: z.boolean(),
      popups: z.array(PopupSchema),
      age_ms: z.number().int(),
      ms: z.number().int(),
    }),
  },
  copy_fallback: {
    args: z.object({ timeout_ms: z.number().int().optional() }),
    result: z.object({ text: z.string(), method: z.literal('copy'), clipboard_restored: z.boolean() }),
  },
  restore_focus: {
    args: z.object({ handle: z.number().int() }),
    result: z.object({
      restored: z.literal(true),
      method: z.enum(['already', 'direct', 'dummy_key', 'attach_thread_input']),
    }),
  },
  window_corners: {
    args: z.object({ handle: z.number().int(), corners: z.enum(['default', 'none', 'round', 'small']) }),
    result: z.object({ applied: z.boolean() }),
  },
  paste: {
    args: z.object({ text: z.string(), settle_ms: z.number().int().optional() }),
    result: z.object({ pasted: z.literal(true) }),
  },
  mouse_hook: { args: Enabled, result: Enabled },
  input_watch: { args: Enabled, result: Enabled },
} as const;

export type CommandName = keyof typeof Commands;
export type CommandArgs<C extends CommandName> = z.input<(typeof Commands)[C]['args']>;
export type CommandResult<C extends CommandName> = z.infer<(typeof Commands)[C]['result']>;

export const RequestSchema = z.looseObject({ id: z.union([z.number(), z.string()]), cmd: z.string() });

export const ErrorResponseSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]),
  ok: z.literal(false),
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});

export const OkResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  ok: z.literal(true),
  result: z.unknown(),
});

export const ResponseSchema = z.union([OkResponseSchema, ErrorResponseSchema]);
export type HelperResponse = z.infer<typeof ResponseSchema>;

export const EventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('ready'), version: z.string(), protocol: z.number().int(), pid: z.number().int() }),
  z.object({
    event: z.literal('mouse_down'),
    x: z.number().int(),
    y: z.number().int(),
    button: z.enum(['left', 'right', 'other']),
  }),
  z.object({ event: z.literal('mouse_up'), x: z.number().int(), y: z.number().int(), drag: z.boolean(), double: z.boolean() }),
  z.object({ event: z.literal('wheel') }),
  z.object({ event: z.literal('keyboard_activity') }),
]);
export type HelperEvent = z.infer<typeof EventSchema>;

export const PROTOCOL_VERSION = 1;
