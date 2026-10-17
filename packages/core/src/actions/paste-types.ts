// Write here's shared types (paste.ts and write.ts), apart from them so the UI's types never reach a `?raw` prompt import.

/** Where the text goes, which decides how many snippets and in what shape. */
export type PasteTarget = 'email' | 'chat' | 'document' | 'code' | 'other';

/** What the user can ask of a written text without typing (the panel's chips). */
export const WRITE_ASKS = ['shorter', 'longer', 'casual', 'formal'] as const;
export type WriteAsk = (typeof WRITE_ASKS)[number];

/** A ready-made request for an empty field, built from saved data with no model call. */
export interface WriteSuggestion {
  kind: 'event' | 'task' | 'snippets';
  /** What the chip says ("Agenda for Thu's Acme review"). */
  label: string;
  /** What is sent as the request when it's picked. */
  request: string;
}
