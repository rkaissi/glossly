import routerPrompt from '../../prompts/router-decision.md?raw';
import type { LlmProvider } from '../llm/types';
import { ruleCollection } from './rules';
import { DecisionsSchema, type DecisionInput, type DecisionProvider, type Decisions } from './types';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function formatDecisionPrompt({ context, collections }: DecisionInput): string {
  return [
    `App: ${context.source_app}`,
    `Window title: ${clip(context.window_title, 200)}`,
    `In an editable field: ${context.is_editable ? 'yes' : 'no'}`,
    `Collections: ${collections.join(', ')}`,
    '',
    '<before>',
    clip(context.context_before, 500),
    '</before>',
    '<selection>',
    clip(context.text, 4000),
    '</selection>',
    '<after>',
    clip(context.context_after, 500),
    '</after>',
  ].join('\n');
}

/** The router's questions answered in one structured call to the Decision (or Fast) model. */
export class LlmStructuredDecision implements DecisionProvider {
  readonly id = 'llm_structured' as const;

  constructor(private readonly llm: LlmProvider) {}

  async decide(input: DecisionInput, signal?: AbortSignal): Promise<Decisions> {
    const out = await this.llm.structured(
      {
        role: 'decision',
        action: 'router',
        instructions: routerPrompt,
        prompt: formatDecisionPrompt(input),
        signal,
        temperature: 0,
        maxOutputTokens: 200,
      },
      DecisionsSchema,
    );
    const known = input.collections.find((c) => c.toLowerCase() === out.best_collection.trim().toLowerCase());
    return {
      ...out,
      best_collection: known ?? ruleCollection(out.content_type, input.features, input.collections),
      provider: 'llm_structured',
    };
  }
}
