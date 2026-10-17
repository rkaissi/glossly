import type { DetectedPerson, Relationship } from '@glossly/core/api';

/** Everything adding a person asks for, the same in Who is this, Reply, and Tasks. */
export interface PersonDraft {
  name: string;
  email: string;
  handle: string;
  /** Saved as the person's note ("About this person"). */
  note: string;
  relationship: Relationship;
}

/** The model's role and about line, joined, as the person's note. */
export function noteFrom(detected: Pick<DetectedPerson, 'detail' | 'about'> | null): string {
  return [detected?.detail, detected?.about].filter((s) => s && s.trim()).join('. ');
}

/** A draft prefilled from what was found in the text. */
export function draftFrom(found: Partial<Pick<DetectedPerson, 'name' | 'email' | 'handle' | 'detail' | 'about' | 'relationship'>> | null, relationship: Relationship = 'other'): PersonDraft {
  return {
    name: found?.name ?? '',
    email: found?.email ?? '',
    handle: found?.handle ?? '',
    note: noteFrom({ detail: found?.detail ?? null, about: found?.about ?? null }),
    relationship: found?.relationship ?? relationship,
  };
}

/** Settings > People's Add person starts from the search box: an email, a @handle, or else a name. */
export function draftFromQuery(query: string): PersonDraft {
  const q = query.trim();
  const d = draftFrom(null);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return { ...d, email: q };
  if (/^@[^\s@]+$/.test(q)) return { ...d, handle: q.slice(1) };
  return { ...d, name: q };
}

/** The fields as `people:create` (and a new person in Tasks) takes them: trimmed, blanks left out. */
export function draftToCreate(d: PersonDraft) {
  return {
    name: d.name.trim(),
    ...(d.email.trim() && { email: d.email.trim() }),
    ...(d.handle.trim() && { handle: d.handle.trim().replace(/^@+/, '') }),
    ...(d.note.trim() && { note: d.note.trim() }),
    relationship: d.relationship,
  };
}
