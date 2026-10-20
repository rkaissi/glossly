// Types shared with the UI (through api.ts). No runtime code.
import type { CalendarEvent } from '../calendar/types';
import type { CommitmentView, PersonSummary } from '../people/types';
import type { Item, ItemLinkKind, LinkPreview } from '../types';

/** Why a saved item came back: an entity it shares with the selection, a similar meaning, or the typed words. */
export type RecallReason = 'same_person' | 'same_company' | 'same_product' | 'same_place' | 'similar_topic' | 'text_match';

/** One saved item, as a Recall card or a search result. */
export interface RecallHit {
  itemId: string;
  /** Clipped for display. */
  text: string;
  why: string | null;
  /** Snippet, Link, Chart, or Memory (decision 84). */
  kind: Item['kind'];
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
  /** Upcoming calendar events (decision 37). */
  events: CalendarEvent[];
  /** False when the embedding model isn't ready, so only exact words were searched. */
  semantic: boolean;
}

/** Narrows the Saved tab (decision 84): by type, by a linked person, by where it was saved. Null is any. */
export interface LibraryFilter {
  kind: Item['kind'] | null;
  personId: string | null;
  /** A site's host ("docs.example.com") for pages, else the app's process name ("slack.exe"). */
  source: string | null;
}

/** The Saved tab in Settings: every saved item, searchable, by type, person, and app or site. */
export interface LibraryQuery extends LibraryFilter {
  query: string;
  /** How many to return; the tab asks for more as the user scrolls. */
  limit: number;
}

/** A person, task, or event an item links to, with what to show for it. */
export interface LibraryLink {
  kind: ItemLinkKind;
  id: string;
  label: string;
}

export interface LibraryItem extends RecallHit {
  /** True when `text` was clipped for display; Copy still copies all of it. */
  clipped: boolean;
  /** The page it was saved from, when saved in a browser. */
  page: { url: string | null; title: string | null } | null;
  /** Web addresses in the text, in order. */
  urls: string[];
  preview: LinkPreview | null;
  links: LibraryLink[];
  /** A chart's Vega-Lite spec with its rows inlined, to draw it again. */
  chartSpec: Record<string, unknown> | null;
}

export interface LibraryResult extends LibraryFilter {
  query: string;
  items: LibraryItem[];
  /** True when there may be more than `items` (ask again with a larger limit). */
  more: boolean;
  /** How many items of each type, and in all (not narrowed by the filter). */
  counts: Record<Item['kind'], number> & { all: number };
  /** The people that saved items link to, for the person filter, by name. */
  people: { id: string; name: string; count: number }[];
  /** Where items were saved (a site's host or an app's process name), most first. */
  sources: { key: string; count: number }[];
  /** False when the embedding model isn't ready, so only exact words were searched. */
  semantic: boolean;
}
