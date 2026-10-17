import { isRoleAddress } from '../people/emails';
import type { Settings } from '../settings';
import type { Features } from './features';
import { CONTEXTUAL_ACTIONS, EMPTY_ACTIONS, type BarAction, type ContextualAction, type Decisions, type EmptyAction, type ScoredAction, type Slots } from './types';

/** What a chat message can look like to the model (a signature or a pasted table is not one). */
const CHAT_TYPES: readonly Decisions['content_type'][] = ['single_message', 'message_thread', 'question', 'other'];

/** The most a model score with nothing in the text to back it can be: below slotThreshold's default, above More's (decisions 51, 53). */
const UNBACKED = 0.45;
/** Phrases too common in newsletters and notices to back a task on their own (decision 53). */
const WEAK_PHRASES = new Set(['please', 'reminder', 'due']);

export function scoreActions(d: Decisions, f: Features): Record<ContextualAction, number> {
  // A short read-only selection in a chat app is someone's message, even when the model, seeing
  // only "what kind of job is it?", calls it a question (decision 45).
  const chat = f.messengerApp && !f.inEditable && f.wordCount <= 150 && CHAT_TYPES.includes(d.content_type);
  const isMessage = d.content_type === 'message_thread' || d.content_type === 'single_message' || chat;
  // Applies to the model's answer too: no Reply for automated mail or the user's own message.
  const answerable = isMessage && !f.automated && !f.authorIsMe;
  const theirs = chat && answerable;
  // A contact card, or a name next to a person's own address or phone, is someone to look up,
  // even when the model reads them as the sender rather than a third person and scores it low.
  const contact =
    d.content_type === 'contact_info' ? 0.9 : f.namePairs.length > 0 && (f.phones.length > 0 || f.emails.some((e) => !isRoleAddress(e))) ? 0.7 : 0;
  return {
    reply: answerable ? Math.max(d.authored_by_other, theirs ? 0.7 : 0) : 0,
    // Whoever wrote someone else's chat message is someone to look up. The model's score counts
    // in full only when someone other than the user is named in the text (decision 53).
    who: f.knownPeople.length > 0 ? 1 : Math.max(f.someoneNamed ? d.mentions_people : Math.min(d.mentions_people, UNBACKED), contact, theirs ? 0.55 : 0),
    // Tasks and events (decisions 36 and 37): what the text says, an event in it, or a message
    // involving someone you have open tasks with. Not on code or tables.
    // The model's commitment score counts in full only with something in the text to back it: a
    // commitment phrase, a date, or an event. Else it stays under More (decision 51).
    promises: Math.max(
      f.commitmentPhrases.some((p) => !WEAK_PHRASES.has(p)) || f.hasDateWord || f.eventSentences > 0 ? d.contains_commitment : Math.min(d.contains_commitment, UNBACKED),
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
  /** A Chat model is available to write (a key, or a local model under Local only). */
  model: boolean;
  /** The caret is in a field with text around it and something is saved, so older snippets may fit too. */
  writing?: boolean;
  /** 0 to 1: the caret is in a box that answers someone (`fieldReplyScore`, decision 75). */
  reply?: number;
}

/** Reply's place on the empty bar once the field is more likely a reply box than not: slot 3, ahead of Write here. */
const REPLY_LEADS = 0.95;

/**
 * Nothing selected: Search always, in slot 2 (decision 82; its score is only for the debug view).
 * Write here (decision 81) when there is something to write from: recent snippets, text around
 * the caret, or a model and a field to type into (it can write what the user asks from tasks and
 * events). It ranks lower when the focused control doesn't take text, since the text then lands
 * on the clipboard. In a reply box, Reply takes slot 3 and Write here slot 4; when it only might
 * be one, Reply keeps its score and so sits under More or nowhere.
 */
export function scoreEmptyActions(c: EmptyContext): Record<EmptyAction, number> {
  const something = c.recent > 0 || c.writing || (c.model && c.editable === true);
  const reply = c.reply ?? 0;
  return {
    reply: reply > 0.5 ? REPLY_LEADS : reply,
    search: 0.9,
    write: !something ? 0 : c.editable === false ? 0.3 : 0.8,
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

/** The empty-bar actions that compete for slots 3 and 4; Search always has slot 2, where Save would be (decision 82). */
const RANKED_EMPTY = EMPTY_ACTIONS.filter((a): a is Exclude<EmptyAction, 'search'> => a !== 'search');

/** The same rule for the bar with nothing selected, for Reply and Write here. */
export function assignEmptySlots(c: EmptyContext, thresholds: Settings['router']): Slots {
  const scores = scoreEmptyActions(c);
  return { ...rankSlots({ reply: scores.reply, write: scores.write }, RANKED_EMPTY, thresholds), scores };
}
