import type { Settings } from '../settings';
import type { Features } from './features';
import { CONTEXTUAL_ACTIONS, EMPTY_ACTIONS, type BarAction, type ContextualAction, type Decisions, type EmptyAction, type ScoredAction, type Slots } from './types';

export function scoreActions(d: Decisions, f: Features): Record<ContextualAction, number> {
  const isMessage = d.content_type === 'message_thread' || d.content_type === 'single_message';
  // Applies to the model's answer too: no Reply for automated mail or the user's own message.
  const answerable = isMessage && !f.automated && !f.authorIsMe;
  return {
    reply: answerable ? d.authored_by_other : 0,
    who: f.knownPeople.length > 0 ? 1 : d.mentions_people,
    promises: d.contains_commitment,
    visualize: d.content_type === 'table_or_numbers' ? 1 : 0,
  };
}

/** What the bar knows when the hotkey finds nothing selected. */
export interface EmptyContext {
  /** Whether the focused control takes text; null when the helper couldn't tell. */
  editable: boolean | null;
  /** Saved items recent enough to paste. */
  recent: number;
  /** A model is available for the summary (a key, and Local only off). */
  summaryModel: boolean;
}

/**
 * Nothing selected: Search always; pasting recent snippets when there are some, ranked lower
 * when the focused control doesn't take text (it then lands on the clipboard). The summary
 * needs a model; without one it stays under More, where it explains why.
 */
export function scoreEmptyActions(c: EmptyContext): Record<EmptyAction, number> {
  const paste = c.recent === 0 ? 0 : c.editable === false ? 0.3 : 0.8;
  return {
    search: 0.9,
    paste_list: paste,
    paste_summary: paste === 0 ? 0 : c.summaryModel ? paste - 0.05 : 0.25,
  };
}

/**
 * The slot rule, shared by every action: slots 3 and 4 are the top two above slotThreshold,
 * More is the rest above moreThreshold. Ties keep `order`.
 */
export function rankSlots<A extends BarAction>(scores: Record<A, number>, order: readonly A[], thresholds: Settings['router']): Slots {
  const ranked: ScoredAction[] = order.map((action) => ({ action, score: scores[action] })).sort((a, b) => b.score - a.score);
  const top = ranked.filter((a) => a.score > thresholds.slotThreshold).slice(0, 2);
  const more = ranked.filter((a) => !top.includes(a) && a.score > thresholds.moreThreshold);
  return { slot3: top[0] ?? null, slot4: top[1] ?? null, more, scores };
}

/** Slot 3 and 4: top two above slotThreshold. More: the rest above moreThreshold. */
export function assignSlots(d: Decisions, f: Features, thresholds: Settings['router']): Slots {
  return rankSlots(scoreActions(d, f), CONTEXTUAL_ACTIONS, thresholds);
}

/** The same rule for the bar with nothing selected. */
export function assignEmptySlots(c: EmptyContext, thresholds: Settings['router']): Slots {
  return rankSlots(scoreEmptyActions(c), EMPTY_ACTIONS, thresholds);
}
