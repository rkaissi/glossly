// Types shared with the UI (through api.ts). No runtime code.
import type { CommitmentView, PersonSummary } from '../people/types';

/** Why a saved item came back: an entity it shares with the selection, a similar meaning, or the typed words. */
export type RecallReason = 'same_person' | 'same_company' | 'same_product' | 'same_place' | 'similar_topic' | 'text_match';

/** One saved item, as a Recall card or a search result. */
export interface RecallHit {
  itemId: string;
  /** Clipped for display. */
  text: string;
  why: string | null;
  collection: string | null;
  source_app: string | null;
  window_title: string | null;
  created_at: string;
  reason: RecallReason;
  /** The words that matched, for highlighting. Null for a match by meaning. */
  term: string | null;
  /** Cosine similarity, when the match was by meaning. */
  similarity: number | null;
}

export interface SearchResults {
  query: string;
  items: RecallHit[];
  people: PersonSummary[];
  /** Open commitments only. */
  commitments: CommitmentView[];
  /** False when the embedding model isn't ready, so only exact words were searched. */
  semantic: boolean;
}

/** The Saved tab in Settings: every saved item, searchable, by collection. */
export interface LibraryQuery {
  query: string;
  /** A collection's name, or null for all of them. */
  collection: string | null;
  /** How many to return; the tab asks for more as the user scrolls. */
  limit: number;
}

export interface LibraryItem extends RecallHit {
  kind: 'selection' | 'note' | 'chart';
  /** True when `text` was clipped for display; Copy still copies all of it. */
  clipped: boolean;
}

export interface LibraryResult {
  query: string;
  collection: string | null;
  items: LibraryItem[];
  /** True when there may be more than `items` (ask again with a larger limit). */
  more: boolean;
  /** Every collection with its item count, and the count across all of them. */
  collections: { name: string; count: number }[];
  total: number;
  /** False when the embedding model isn't ready, so only exact words were searched. */
  semantic: boolean;
}
