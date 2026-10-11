// Pure helpers for first-run setup (Step 20.3, decision 41), unit-tested in setup-logic.test.ts.
import type { Identity, Privacy, TryItStep } from '@glossly/core/api';
import { parseEmail, parseHandle } from './format';

export const SETUP_STEPS = ['welcome', 'privacy', 'connect', 'you', 'models', 'search', 'try'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Whether Continue is enabled. Adding a key is required under All models (a working key or local
 * server); under Local only it's optional, since Glossly works on rules without a model.
 */
export function canContinue(step: SetupStep, s: { privacy: Privacy; hasModel: boolean; name: string }): boolean {
  if (step === 'connect') return s.privacy === 'local' || s.hasModel;
  if (step === 'you') return s.name.trim().length > 0;
  return true;
}

/** "Emails and chat names" as one field: "alex@example.com, @alexm" into emails and handles. */
export function splitContacts(raw: string): Pick<Identity, 'emails' | 'handles'> {
  const emails: string[] = [];
  const handles: string[] = [];
  for (const part of raw.split(/[,;\n]+/)) {
    const email = parseEmail(part);
    if (email) {
      if (!emails.includes(email)) emails.push(email);
      continue;
    }
    const handle = parseHandle(part);
    if (handle && !handles.includes(handle)) handles.push(handle);
  }
  return { emails, handles };
}

/** The field's starting text from a saved identity. */
export const joinContacts = (i: Pick<Identity, 'emails' | 'handles'>): string => [...i.emails, ...i.handles.map((h) => `@${h}`)].join(', ');

export const TRY_STEPS: readonly TryItStep[] = ['pill', 'bar', 'action'];

/**
 * How many Try it items are done after `step` happened. Each implies the ones before it (the
 * hotkey opens the bar with no pill), and nothing ever unticks.
 */
export const tickTry = (done: number, step: TryItStep): number => Math.max(done, TRY_STEPS.indexOf(step) + 1);
