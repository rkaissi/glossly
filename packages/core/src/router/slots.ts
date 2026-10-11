import { isRoleAddress } from '../people/emails';
import type { Settings } from '../settings';
import type { Features } from './features';
import { CONTEXTUAL_ACTIONS, EMPTY_ACTIONS, type BarAction, type ContextualAction, type Decisions, type EmptyAction, type ScoredAction, type Slots } from './types';

export function scoreActions(d: Decisions, f: Features): Record<ContextualAction, number> {
  const isMessage = d.content_type === 'message_thread' || d.content_type === 'single_message';
  // Applies to the model's answer too: no Reply for automated mail or the user's own message.
  const answerable = isMessage && !f.automated && !f.authorIsMe;
  // A contact card, or a name next to a person's own address or phone, is someone to look up,
  // even when the model reads them as the sender rather than a third person and scores it low.
  const contact =
    d.content_type === 'contact_info' ? 0.9 : f.namePairs.length > 0 && (f.phones.length > 0 || f.emails.some((e) => !isRoleAddress(e))) ? 0.7 : 0;
  return {
    reply: answerable ? d.authored_by_other : 0,
    who: f.knownPeople.length > 0 ? 1 : Math.max(d.mentions_people, contact),
    // Tasks and events (decisions 36 and 37): what the text says, an event in it, or a message
    // involving someone you have open tasks with. Not on code or tables.
    promises: Math.max(
      d.contains_commitment,
      isMessage && f.peopleWithTasks > 0 ? 0.55 : 0,
      f.eventSentences > 0 && d.content_type !== 'code' && d.content_type !== 'table_or_numbers' ? 0.7 : 0,
    ),
    visualize: d.content_type === 'table_or_numbers' ? 1 : 0,
  };
}

/** What the bar knows when the hotkey finds nothing selected. */
export interface EmptyContext {
  /** Whether the focused control takes text; null when the helper couldn't tell. */
  editable: boolean | null;
  /** Saved items recent enough to paste. */
  recent: number;
  /** A model is available for the summary (a key, or a local model under Local only). */
  summaryModel: boolean;
  /** The caret is in a field with text around it and something is saved, so older snippets may fit too. */
  writing?: boolean;
}

/**
 * Nothing selected: Search always; pasting snippets when there are some, ranked lower when the
 * focused control doesn't take text (it then lands on the clipboard). While the user is writing
 * (text around the caret), "Write it for here" goes ahead of the plain list, since it picks the
 * snippets that fit and shapes them for the spot. It needs a model; without one it stays under
 * More, where it explains why.
 */
export function scoreEmptyActions(c: EmptyContext): Record<EmptyAction, number> {
  const paste = c.recent === 0 && !c.writing ? 0 : c.editable === false ? 0.3 : 0.8;
  return {
    search: 0.9,
    paste_list: paste,
    paste_summary: paste === 0 ? 0 : !c.summaryModel ? 0.25 : c.writing ? paste + 0.05 : paste - 0.05,
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
