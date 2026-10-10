// How the user knows a person. Reply learns per relationship (friends, colleagues, ...) as well
// as per person, since one person rarely gives enough replies to learn from. Unknown is null.

export const RELATIONSHIPS = ['friend', 'family', 'colleague', 'professional', 'acquaintance', 'stranger', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const asRelationship = (v: unknown): Relationship | null =>
  typeof v === 'string' && (RELATIONSHIPS as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as Relationship) : null;

/** "with friends", "with professional contacts". */
export const RELATIONSHIP_PLURALS: Record<Relationship, string> = {
  friend: 'friends',
  family: 'family',
  colleague: 'colleagues',
  professional: 'professional contacts',
  acquaintance: 'acquaintances',
  stranger: 'strangers',
  other: 'other people',
};
