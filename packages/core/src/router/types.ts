import { z } from 'zod';

export const ContentTypeSchema = z.enum([
  'message_thread',
  'single_message',
  'table_or_numbers',
  'article',
  'code',
  'contact_info',
  'question',
  'other',
]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const DecisionProviderIdSchema = z.enum(['jev', 'openai_decisions', 'llm_structured', 'rules']);
export type DecisionProviderId = z.infer<typeof DecisionProviderIdSchema>;

const P = z.number().min(0).max(1);

/** Our output contract for every decision provider (spec: Router step 2). */
export const DecisionsSchema = z.object({
  content_type: ContentTypeSchema,
  authored_by_other: P,
  mentions_people: P,
  contains_commitment: P,
  best_collection: z.string(),
  provider: DecisionProviderIdSchema,
});
export type Decisions = z.infer<typeof DecisionsSchema>;

/** Tier-1 context: the router's only input. */
export interface SelectionContext {
  text: string;
  context_before: string;
  context_after: string;
  source_app: string;
  window_title: string;
  is_editable: boolean;
}

export interface KnownPerson {
  id: string;
  name: string;
  aliases: string[];
}

export interface DecisionInput {
  context: SelectionContext;
  features: import('./features').Features;
  collections: string[];
}

export interface DecisionProvider {
  readonly id: DecisionProviderId;
  decide(input: DecisionInput, signal?: AbortSignal): Promise<Decisions>;
}

export const CONTEXTUAL_ACTIONS = ['reply', 'who', 'promises', 'visualize'] as const;
export type ContextualAction = (typeof CONTEXTUAL_ACTIONS)[number];

/** The actions for the bar with nothing selected (hotkey): search, and pasting recent snippets. */
export const EMPTY_ACTIONS = ['search', 'paste_list', 'paste_summary'] as const;
export type EmptyAction = (typeof EMPTY_ACTIONS)[number];

/** Everything that competes for slots 3 and 4 under the slot rule. */
export type BarAction = ContextualAction | EmptyAction;

export interface ScoredAction {
  action: BarAction;
  score: number;
}

export interface Slots {
  /** Slots 3 and 4. Null when nothing scored above the threshold. Positions never shift. */
  slot3: ScoredAction | null;
  slot4: ScoredAction | null;
  /** Under "More" (Tab). */
  more: ScoredAction[];
  scores: Partial<Record<BarAction, number>>;
}
