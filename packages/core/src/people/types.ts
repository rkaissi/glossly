// People layer records (spec: People layer, Data model) and the views the UI renders.
// Types only, so the UI can import them through `@glossly/core/api`.

import type { Relationship } from './relationship';
import type { ReplyChannel } from './reply-style';

export type AliasKind = 'email' | 'handle' | 'name';

export interface PersonAlias {
  kind: AliasKind;
  value: string;
}

export interface Person {
  id: string;
  entity_id: string | null;
  name: string;
  /** About this person. The model can prefill it; the user can edit it. */
  note: string | null;
  /** Friend, colleague, ...; null when unknown. Reply learns per relationship. */
  relationship: Relationship | null;
  created_at: string;
  updated_at: string;
  aliases: PersonAlias[];
}

export type CommitmentOwner = 'me' | 'them';
export type CommitmentStatus = 'open' | 'done' | 'dropped';

export interface Commitment {
  id: string;
  person_id: string | null;
  owner: CommitmentOwner;
  text: string;
  /** "YYYY-MM-DD" for a date, a full ISO 8601 timestamp with offset for a time, or null. */
  due_at: string | null;
  status: CommitmentStatus;
  source_interaction_id: string | null;
  created_at: string;
  notified_at: string | null;
}

export type InteractionDirection = 'inbound' | 'outbound';

export interface Interaction {
  id: string;
  person_id: string;
  direction: InteractionDirection;
  text: string;
  source_app: string | null;
  occurred_at: string;
}

/** pasted: from the Profile tab. inserted: a reply inserted as drafted. inserted_edited: edited first. */
/** `inserted` (an unedited draft) is no longer stored; migration 3 removed the old ones. */
export type VoiceOrigin = 'pasted' | 'inserted' | 'inserted_edited';

export interface VoiceSample {
  id: string;
  text: string;
  origin: VoiceOrigin;
  created_at: string;
  /** Where an edited reply was written (email, chat, other); null for pasted samples. */
  channel: ReplyChannel | null;
  /** Who it was written to, when they are in the user's people. */
  person_id: string | null;
  /** The model's draft before the user's edit, for the style notes. */
  original: string | null;
}

export interface StyleNote {
  id: string;
  text: string;
  created_at: string;
}

// ---- views ----

export interface CommitmentView {
  id: string;
  owner: CommitmentOwner;
  text: string;
  due_at: string | null;
  status: CommitmentStatus;
  person_id: string | null;
  person_name: string | null;
}

export interface InteractionView {
  id: string;
  direction: InteractionDirection;
  /** Clipped for display. */
  text: string;
  source_app: string | null;
  occurred_at: string;
}

export interface PersonItemView {
  id: string;
  /** Clipped for display. */
  text: string;
  why: string | null;
  collection: string | null;
  source_app: string | null;
  created_at: string;
}

/** The "Who is this" card and the full record in Settings. */
export interface PersonCard {
  id: string;
  name: string;
  note: string | null;
  relationship: Relationship | null;
  aliases: PersonAlias[];
  /** Open commitments you made to them. */
  youOwe: CommitmentView[];
  /** Open commitments they made to you. */
  theyOwe: CommitmentView[];
  /** Newest first. The overlay gets the last 5; the full record gets more. */
  interactions: InteractionView[];
  /** Saved items that mention them, newest first. */
  items: PersonItemView[];
  created_at: string;
}

export interface PersonSummary {
  id: string;
  name: string;
  aliases: string[];
  note: string | null;
  open: number;
  /** Latest interaction, or null. */
  last_seen: string | null;
}

// ---- What did I promise ----

/** One candidate commitment, ready for the review list. */
export interface PromiseRow {
  key: string;
  owner: CommitmentOwner;
  text: string;
  /** As the model returned it, or null. */
  due_phrase: string | null;
  /** Resolved by code: "YYYY-MM-DD", an ISO timestamp, or null ("No date"). */
  due_at: string | null;
  confidence: number;
  selected: boolean;
  person_name: string | null;
  /** The person record the name resolved to; a fuzzy match is only a suggestion. */
  match: { personId: string; name: string; kind: 'exact' | 'fuzzy' } | null;
}

/** A reviewed row to save. `person` is an existing record, a new one to create, or nobody. */
export interface PromiseSaveRow {
  owner: CommitmentOwner;
  text: string;
  due_at: string | null;
  person: { kind: 'existing'; id: string } | { kind: 'new'; name: string } | null;
}
