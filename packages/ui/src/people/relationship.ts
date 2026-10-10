import type { Relationship } from '@glossly/core/api';

/** Choices for a person's relationship. A Record, so a value added in core fails typecheck here until it has a label. */
const LABELS: Record<Relationship, string> = {
  friend: 'Friend',
  family: 'Family',
  colleague: 'Colleague',
  professional: 'Professional (recruiter, client, ...)',
  acquaintance: 'Acquaintance',
  stranger: 'Stranger',
  other: 'Other',
};

export const RELATIONSHIP_OPTIONS = Object.entries(LABELS) as [Relationship, string][];
