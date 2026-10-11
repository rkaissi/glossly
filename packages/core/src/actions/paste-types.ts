// Paste's shared types, apart from paste.ts so the UI's types never reach a `?raw` prompt import.

/** Where the paste goes, which decides how many snippets and in what shape. */
export type PasteTarget = 'email' | 'chat' | 'document' | 'code' | 'other';

/** The shape the model chose for "Write it for here"; shown in the panel. */
export const PASTE_FORMATS = ['sentences', 'bullets', 'numbered', 'message', 'summary'] as const;
export type PasteFormat = (typeof PASTE_FORMATS)[number];
