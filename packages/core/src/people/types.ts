// People layer records (spec: People layer, Data model) and the views the UI renders.
// Types only, so the UI can import them through `@glossly/core/api`.

import type { CalendarEvent } from '../calendar/types';
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
/**
 * `inserted` (an unedited draft) is no longer stored; migration 3 removed the old ones.
 * `written` is a reply the user wrote themselves instead of taking a draft.
 */
export type VoiceOrigin = 'pasted' | 'inserted' | 'inserted_edited' | 'written';

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
  /** When it was done or dropped; null while open and for tasks finished before migration 6. */
  completed_at: string | null;
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
  /** Their next calendar events (decision 37), soonest first. */
  events: CalendarEvent[];
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

// ---- Tasks (formerly What did I promise) ----

/** One candidate commitment, ready for the review list. */
/**
 * What a row found in the message does to the user's tasks (decision 36): a new task, the same
 * as an open one (nothing to save), finishes an open one, or moves its due date.
 */
export type TaskChange = 'new' | 'same' | 'done' | 'moved';

export interface PromiseRow {
  key: string;
  change: TaskChange;
  /** The open task a same, done, or moved row is about; null for a new one. */
  existing: CommitmentView | null;
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
  /** What the people reader (Who's) found about `person_name`, for creating them; null when it found nothing or they are saved. */
  details: NewPersonDetails | null;
}

/** What Who's reader knows about someone not saved yet: the same fields Create person prefills. */
export interface NewPersonDetails {
  email: string | null;
  handle: string | null;
  /** The role and the about line, joined, as Who's Create person writes the note. */
  note: string | null;
  relationship: Relationship | null;
}

/** A reviewed row to save. `person` is an existing record, a new one to create, or nobody. */
export interface PromiseSaveRow {
  /** Missing means "new". */
  change?: TaskChange;
  /** The open task to finish or move, for "done" and "moved". */
  existingId?: string;
  owner: CommitmentOwner;
  text: string;
  due_at: string | null;
  person: { kind: 'existing'; id: string } | ({ kind: 'new'; name: string } & Partial<NewPersonDetails>) | null;
}
