import type { Features } from './features';
import type { ContentType, DecisionInput, DecisionProvider, Decisions } from './types';

function contentType(f: Features): ContentType {
  if (f.codeScore >= 0.45 || (f.codeEditorApp && f.codeScore >= 0.25)) return 'code';
  if (f.tableShape || f.numericDensity > 0.3) return 'table_or_numbers';
  if (f.chatLines >= 2) return 'message_thread';
  if ((f.emails.length > 0 || f.phones.length > 0) && f.wordCount <= 60 && f.lineCount >= 2) return 'contact_info';
  if (f.messengerApp && f.wordCount <= 150) return f.chatLines >= 1 && f.lineCount >= 3 ? 'message_thread' : 'single_message';
  if (f.endsWithQuestion && f.wordCount <= 40) return 'question';
  if (f.wordCount >= 60 || (f.wordCount >= 35 && f.sentences >= 2)) return 'article';
  return 'other';
}

/** Picks from the user's existing collections only. */
export function ruleCollection(type: ContentType, f: Features, collections: string[]): string {
  const has = (name: string) => collections.find((c) => c.toLowerCase() === name.toLowerCase());
  const pick =
    (type === 'contact_info' && has('People notes')) ||
    (f.ideaWords && has('Ideas')) ||
    (type === 'article' && has('Reading')) ||
    has('Notes') ||
    collections[0];
  return pick ?? 'Notes';
}

/** Deterministic features only. Always available; the fallback for every other provider. */
export class RulesDecision implements DecisionProvider {
  readonly id = 'rules' as const;

  async decide(input: DecisionInput): Promise<Decisions> {
    return decideByRules(input);
  }
}

export function decideByRules({ context, features: f, collections }: DecisionInput): Decisions {
  const type = contentType(f);
  const isMessage = type === 'message_thread' || type === 'single_message';

  // Text in an editable field is usually the user's own draft; automated mail has nobody to answer.
  let authored = isMessage ? (f.messengerApp ? 0.7 : 0.55) : 0.1;
  if (context.is_editable || f.automated || f.authorIsMe) authored = Math.min(authored, 0.15);

  // Names in articles, tables, and code are rarely people the user knows.
  const weakNames = type === 'article' || type === 'table_or_numbers' || type === 'code';
  const mentions =
    f.knownPeople.length > 0
      ? 1
      : f.emails.length + f.handles.length > 0
        ? 0.7
        : f.namePairs.length > 0
          ? weakNames
            ? 0.3
            : 0.55
          : type === 'message_thread'
            ? 0.4
            : 0.1;

  const n = f.commitmentPhrases.length;
  const commitment = n === 0 ? 0.05 : n === 1 && !f.hasDateWord ? 0.55 : 0.75;

  return {
    content_type: type,
    authored_by_other: authored,
    mentions_people: mentions,
    contains_commitment: type === 'code' || type === 'table_or_numbers' ? Math.min(commitment, 0.2) : commitment,
    best_collection: ruleCollection(type, f, collections),
    provider: 'rules',
  };
}
