import type { Settings } from '../settings';
import type { Features } from './features';
import { CONTEXTUAL_ACTIONS, type ContextualAction, type Decisions, type ScoredAction, type Slots } from './types';

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

/** Slot 3 and 4: top two above slotThreshold. More: the rest above moreThreshold. */
export function assignSlots(d: Decisions, f: Features, thresholds: Settings['router']): Slots {
  const scores = scoreActions(d, f);
  // Stable order on ties: the CONTEXTUAL_ACTIONS order.
  const ranked: ScoredAction[] = CONTEXTUAL_ACTIONS.map((action) => ({ action, score: scores[action] })).sort(
    (a, b) => b.score - a.score,
  );
  const top = ranked.filter((a) => a.score > thresholds.slotThreshold).slice(0, 2);
  const more = ranked.filter((a) => !top.includes(a) && a.score > thresholds.moreThreshold);
  return { slot3: top[0] ?? null, slot4: top[1] ?? null, more, scores };
}
