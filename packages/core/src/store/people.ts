import { uuidv7 } from 'uuidv7';
import { canonicalize, normalizeEmail, normalizeHandle } from '../people/names';
import type { Relationship } from '../people/relationship';
import type { ReplyChannel, StyleDimension, StyleSignal, StyleSignalRow } from '../people/reply-style';
import type {
  AliasKind,
  Commitment,
  CommitmentOwner,
  CommitmentStatus,
  CommitmentView,
  Interaction,
  InteractionDirection,
  InteractionView,
  Person,
  PersonAlias,
  PersonCard,
  PersonItemView,
  PersonSummary,
  StyleNote,
  VoiceOrigin,
  VoiceSample,
} from '../people/types';
import { isoNow } from '../types';
import type { Store } from './store';

const MAX_NAME = 100;
const MAX_NOTE = 1000;
const MAX_ALIAS = 200;
const MAX_TEXT = 2000;
/** Edited replies kept as voice samples; older ones are dropped. */
const MAX_INSERTED_VOICE = 20;
/** Pick signals kept for learning; the learner only looks at the newest 20 per trait and scope. */
const MAX_STYLE_SIGNALS = 1000;
const MAX_STYLE_NOTE = 160;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Normalizes an alias value for its kind, or null when it is empty. */
export function normalizeAlias(kind: AliasKind, value: string): string | null {
  const v = kind === 'email' ? normalizeEmail(value) : kind === 'handle' ? normalizeHandle(value) : oneLine(value);
  return v && v.length <= MAX_ALIAS ? v : null;
}

/** Guesses an alias kind from what was typed: "a@b.c" is an email, "@sam" a handle, else a name. */
export function aliasKindOf(raw: string): AliasKind {
  const v = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (v.startsWith('@')) return 'handle';
  return 'name';
}

export class AliasTakenError extends Error {
  constructor(readonly owner: string) {
    super(`That alias already belongs to ${owner}.`);
    this.name = 'AliasTakenError';
  }
}

export interface NewPerson {
  name: string;
  note?: string | null;
  relationship?: Relationship | null;
  aliases?: PersonAlias[];
}

export interface NewCommitment {
  person_id: string | null;
  owner: CommitmentOwner;
  text: string;
  due_at: string | null;
  source_interaction_id?: string | null;
}

/**
 * People, aliases, interactions, commitments, and voice samples. Every person record is built
 * only from what the user captured or typed. Nothing here ever merges two people on its own.
 */
export class PeopleRepo {
  constructor(
    private readonly store: Store,
    private readonly now: () => string = isoNow,
  ) {}

  private get db() {
    return this.store.db;
  }

  // ---- people ----

  create(p: NewPerson): Person {
    const name = clip(oneLine(p.name), MAX_NAME);
    if (!name) throw new Error('A person needs a name.');
    const id = uuidv7();
    const at = this.now();
    this.store.tx(() => {
      this.db
        .prepare('INSERT INTO people (id, entity_id, name, note, relationship, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)')
        .run(id, name, p.note?.trim() ? clip(p.note.trim(), MAX_NOTE) : null, p.relationship ?? null, at, at);
      for (const a of p.aliases ?? []) this.insertAlias(id, a.kind, a.value, true);
      this.linkEntity(id);
    });
    return this.get(id)!;
  }

  get(id: string): Person | null {
    const row = this.db.prepare('SELECT id, entity_id, name, note, relationship, created_at, updated_at FROM people WHERE id = ?').get(id) as
      | Omit<Person, 'aliases'>
      | undefined;
    if (!row) return null;
    return { ...row, aliases: this.aliases(id) };
  }

  aliases(personId: string): PersonAlias[] {
    return this.db
      .prepare("SELECT kind, value FROM person_aliases WHERE person_id = ? ORDER BY CASE kind WHEN 'name' THEN 0 WHEN 'email' THEN 1 ELSE 2 END, value")
      .all(personId) as unknown as PersonAlias[];
  }

  list(query = ''): PersonSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.note,
           (SELECT COUNT(*) FROM commitments c WHERE c.person_id = p.id AND c.status = 'open') AS open,
           (SELECT MAX(occurred_at) FROM interactions i WHERE i.person_id = p.id) AS last_seen
         FROM people p ORDER BY p.name COLLATE NOCASE`,
      )
      .all() as { id: string; name: string; note: string | null; open: number; last_seen: string | null }[];
    const q = canonicalize(query);
    const out: PersonSummary[] = [];
    for (const r of rows) {
      const aliases = this.aliases(r.id).map((a) => a.value);
      if (q && ![r.name, ...aliases].some((v) => canonicalize(v).includes(q))) continue;
      out.push({ ...r, aliases });
    }
    return out;
  }

  update(id: string, patch: { name?: string; note?: string | null; relationship?: Relationship | null }): Person {
    const p = this.get(id);
    if (!p) throw new Error('That person no longer exists.');
    const name = patch.name !== undefined ? clip(oneLine(patch.name), MAX_NAME) : p.name;
    if (!name) throw new Error('A person needs a name.');
    const note = patch.note !== undefined ? (patch.note?.trim() ? clip(patch.note.trim(), MAX_NOTE) : null) : p.note;
    const relationship = patch.relationship !== undefined ? patch.relationship : p.relationship;
    this.store.tx(() => {
      this.db.prepare('UPDATE people SET name = ?, note = ?, relationship = ?, updated_at = ? WHERE id = ?').run(name, note, relationship, this.now(), id);
      // The old name stays findable.
      if (canonicalize(name) !== canonicalize(p.name)) this.insertAlias(id, 'name', p.name, true);
      this.linkEntity(id);
    });
    return this.get(id)!;
  }

  /** Adds an alias. Throws AliasTakenError when another person already has it. */
  addAlias(personId: string, kind: AliasKind, value: string): Person {
    if (!this.get(personId)) throw new Error('That person no longer exists.');
    this.store.tx(() => {
      this.insertAlias(personId, kind, value, false);
      this.db.prepare('UPDATE people SET updated_at = ? WHERE id = ?').run(this.now(), personId);
      if (kind === 'name') this.linkEntity(personId);
    });
    return this.get(personId)!;
  }

  removeAlias(personId: string, kind: AliasKind, value: string): Person {
    this.db.prepare('DELETE FROM person_aliases WHERE person_id = ? AND kind = ? AND value = ?').run(personId, kind, value);
    const p = this.get(personId);
    if (!p) throw new Error('That person no longer exists.');
    return p;
  }

  private insertAlias(personId: string, kind: AliasKind, raw: string, quiet: boolean): void {
    const value = normalizeAlias(kind, raw);
    if (!value) {
      if (quiet) return;
      throw new Error('Type an alias first.');
    }
    const person = this.db.prepare('SELECT name FROM people WHERE id = ?').get(personId) as { name: string } | undefined;
    // A name alias equal to the person's own name adds nothing.
    if (kind === 'name' && person && canonicalize(person.name) === canonicalize(value)) return;
    const owner = this.db
      .prepare('SELECT p.id, p.name FROM person_aliases a JOIN people p ON p.id = a.person_id WHERE a.kind = ? AND a.value = ?')
      .get(kind, value) as { id: string; name: string } | undefined;
    if (owner) {
      if (owner.id === personId || quiet) return;
      throw new AliasTakenError(owner.name);
    }
    this.db.prepare('INSERT INTO person_aliases (person_id, kind, value) VALUES (?, ?, ?)').run(personId, kind, value);
  }

  /**
   * Links the person to the "person" entity Save extracted under their name or a name alias,
   * so items saved before the person existed count as mentioning them.
   */
  private linkEntity(personId: string): void {
    const p = this.db.prepare('SELECT name, entity_id FROM people WHERE id = ?').get(personId) as { name: string; entity_id: string | null } | undefined;
    if (!p || p.entity_id) return;
    for (const c of this.canonicalNames(personId)) {
      const e = this.db
        .prepare("SELECT id FROM entities WHERE kind = 'person' AND canonical = ? AND id NOT IN (SELECT entity_id FROM people WHERE entity_id IS NOT NULL)")
        .get(c) as { id: string } | undefined;
      if (e) {
        this.db.prepare('UPDATE people SET entity_id = ? WHERE id = ?').run(e.id, personId);
        return;
      }
    }
  }

  private canonicalNames(personId: string): string[] {
    const p = this.db.prepare('SELECT name FROM people WHERE id = ?').get(personId) as { name: string } | undefined;
    if (!p) return [];
    const names = (this.db.prepare("SELECT value FROM person_aliases WHERE person_id = ? AND kind = 'name'").all(personId) as { value: string }[]).map(
      (r) => r.value,
    );
    return [...new Set([p.name, ...names].map(canonicalize).filter(Boolean))];
  }

  /**
   * Folds `dropId` into `keepId` after the user confirmed they are the same person: aliases
   * (plus the dropped name), interactions, and commitments move over, then `dropId` is deleted.
   */
  merge(keepId: string, dropId: string): Person {
    if (keepId === dropId) throw new Error('Pick two different people.');
    const keep = this.get(keepId);
    const drop = this.get(dropId);
    if (!keep || !drop) throw new Error('That person no longer exists.');
    this.store.tx(() => {
      this.db.prepare('UPDATE interactions SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
      this.db.prepare('UPDATE commitments SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
      this.db.prepare('UPDATE voice_samples SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
      this.db.prepare('UPDATE style_signals SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
      const moved = drop.aliases;
      this.db.prepare('DELETE FROM person_aliases WHERE person_id = ?').run(dropId);
      this.db.prepare('DELETE FROM people WHERE id = ?').run(dropId);
      for (const a of moved) this.insertAlias(keepId, a.kind, a.value, true);
      this.insertAlias(keepId, 'name', drop.name, true);
      const note = [keep.note, drop.note].filter(Boolean).join('\n') || null;
      this.db.prepare('UPDATE people SET note = ?, entity_id = COALESCE(entity_id, ?), updated_at = ? WHERE id = ?').run(note, drop.entity_id, this.now(), keepId);
    });
    return this.get(keepId)!;
  }

  /** Deletes the person with their aliases, interactions, and commitments. Saved items stay. */
  delete(id: string): boolean {
    return this.store.tx(() => {
      this.db.prepare('DELETE FROM person_aliases WHERE person_id = ?').run(id);
      this.db.prepare('DELETE FROM commitments WHERE person_id = ?').run(id);
      this.db.prepare('DELETE FROM interactions WHERE person_id = ?').run(id);
      // What was learned stays with the channel; only the link to them goes.
      this.db.prepare('UPDATE voice_samples SET person_id = NULL WHERE person_id = ?').run(id);
      this.db.prepare('UPDATE style_signals SET person_id = NULL WHERE person_id = ?').run(id);
      return Number(this.db.prepare('DELETE FROM people WHERE id = ?').run(id).changes) > 0;
    });
  }

  // ---- lookups for person resolution ----

  byAlias(kind: 'email' | 'handle', value: string): string | null {
    const v = normalizeAlias(kind, value);
    if (!v) return null;
    const row = this.db.prepare('SELECT person_id FROM person_aliases WHERE kind = ? AND value = ?').get(kind, v) as { person_id: string } | undefined;
    return row?.person_id ?? null;
  }

  /** Exact match on the full name or a name alias, in canonical form. */
  byName(name: string): string | null {
    return this.store.findPersonByName(name)?.id ?? null;
  }

  /** Every person's canonical names, for fuzzy matching. */
  nameIndex(): { personId: string; names: string[] }[] {
    const ids = this.db.prepare('SELECT id FROM people').all() as { id: string }[];
    return ids.map((r) => ({ personId: r.id, names: this.canonicalNames(r.id) }));
  }

  /** People seen in an app: an interaction there, or a saved item from there that mentions them. */
  seenIn(sourceApp: string): Set<string> {
    const app = sourceApp.toLowerCase();
    const ids = new Set<string>();
    for (const r of this.db.prepare('SELECT DISTINCT person_id FROM interactions WHERE lower(source_app) = ?').all(app) as { person_id: string }[]) {
      ids.add(r.person_id);
    }
    for (const p of this.db.prepare('SELECT id FROM people').all() as { id: string }[]) {
      if (!ids.has(p.id) && this.itemIds(p.id, 1, app).length > 0) ids.add(p.id);
    }
    return ids;
  }

  // ---- interactions ----

  addInteraction(i: { person_id: string; direction: InteractionDirection; text: string; source_app?: string | null; occurred_at?: string }): Interaction {
    const row: Interaction = {
      id: uuidv7(),
      person_id: i.person_id,
      direction: i.direction,
      text: clip(i.text.trim(), MAX_TEXT),
      source_app: i.source_app || null,
      occurred_at: i.occurred_at ?? this.now(),
    };
    this.db
      .prepare('INSERT INTO interactions (id, person_id, direction, text, source_app, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.person_id, row.direction, row.text, row.source_app, row.occurred_at);
    return row;
  }

  interactions(personId: string, limit = 5): Interaction[] {
    return this.db
      .prepare('SELECT * FROM interactions WHERE person_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?')
      .all(personId, limit) as unknown as Interaction[];
  }

  deleteInteraction(id: string): void {
    this.db.prepare('UPDATE commitments SET source_interaction_id = NULL WHERE source_interaction_id = ?').run(id);
    this.db.prepare('DELETE FROM interactions WHERE id = ?').run(id);
  }

  // ---- commitments ----

  addCommitment(c: NewCommitment): Commitment {
    const text = clip(oneLine(c.text), 500);
    if (!text) throw new Error('A commitment needs text.');
    const row: Commitment = {
      id: uuidv7(),
      person_id: c.person_id,
      owner: c.owner,
      text,
      due_at: c.due_at,
      status: 'open',
      source_interaction_id: c.source_interaction_id ?? null,
      created_at: this.now(),
      notified_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO commitments (id, person_id, owner, text, due_at, status, source_interaction_id, created_at, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(row.id, row.person_id, row.owner, row.text, row.due_at, row.status, row.source_interaction_id, row.created_at);
    return row;
  }

  getCommitment(id: string): Commitment | null {
    return (this.db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as Commitment | undefined) ?? null;
  }

  /** Commitments with the person's name, open ones by due date (undated last), then the rest newest first. */
  commitments(filter: { personId?: string; status?: CommitmentStatus } = {}): CommitmentView[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.personId) {
      where.push('c.person_id = ?');
      args.push(filter.personId);
    }
    if (filter.status) {
      where.push('c.status = ?');
      args.push(filter.status);
    }
    return this.db
      .prepare(
        `SELECT c.id, c.owner, c.text, c.due_at, c.status, c.person_id, p.name AS person_name
         FROM commitments c LEFT JOIN people p ON p.id = c.person_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY c.status = 'open' DESC, c.due_at IS NULL, c.due_at, c.created_at DESC`,
      )
      .all(...args) as unknown as CommitmentView[];
  }

  setCommitmentStatus(id: string, status: CommitmentStatus): void {
    this.db.prepare('UPDATE commitments SET status = ? WHERE id = ?').run(status, id);
  }

  deleteCommitment(id: string): void {
    this.db.prepare('DELETE FROM commitments WHERE id = ?').run(id);
  }

  /** Open commitments due on or before `today` (local "YYYY-MM-DD") whose notification hasn't been shown. */
  dueUnnotified(today: string): CommitmentView[] {
    return this.db
      .prepare(
        `SELECT c.id, c.owner, c.text, c.due_at, c.status, c.person_id, p.name AS person_name
         FROM commitments c LEFT JOIN people p ON p.id = c.person_id
         WHERE c.status = 'open' AND c.notified_at IS NULL AND c.due_at IS NOT NULL AND substr(c.due_at, 1, 10) <= ?
         ORDER BY c.due_at`,
      )
      .all(today) as unknown as CommitmentView[];
  }

  markNotified(id: string): void {
    this.db.prepare('UPDATE commitments SET notified_at = ? WHERE id = ?').run(this.now(), id);
  }

  // ---- saved items that mention a person ----

  private itemIds(personId: string, limit: number, sourceApp?: string): string[] {
    const p = this.db.prepare('SELECT entity_id FROM people WHERE id = ?').get(personId) as { entity_id: string | null } | undefined;
    if (!p) return [];
    const names = this.canonicalNames(personId);
    const marks = names.map(() => '?').join(', ') || "''";
    return (
      this.db
        .prepare(
          `SELECT DISTINCT i.id, i.created_at FROM items i
           JOIN item_entities ie ON ie.item_id = i.id JOIN entities e ON e.id = ie.entity_id
           WHERE (e.id = ? OR (e.kind = 'person' AND e.canonical IN (${marks})))
           ${sourceApp ? 'AND lower(i.source_app) = ?' : ''}
           ORDER BY i.created_at DESC LIMIT ?`,
        )
        .all(p.entity_id ?? '', ...names, ...(sourceApp ? [sourceApp] : []), limit) as { id: string }[]
    ).map((r) => r.id);
  }

  items(personId: string, limit = 5): PersonItemView[] {
    const ids = this.itemIds(personId, limit);
    return ids.flatMap((id) => {
      const r = this.db
        .prepare('SELECT i.id, i.text, i.why, i.source_app, i.created_at, c.name AS collection FROM items i LEFT JOIN collections c ON c.id = i.collection_id WHERE i.id = ?')
        .get(id) as (Omit<PersonItemView, 'text'> & { text: string }) | undefined;
      return r ? [{ ...r, text: clip(oneLine(r.text), 240) }] : [];
    });
  }

  // ---- the card ----

  card(personId: string, opts: { interactions?: number; items?: number } = {}): PersonCard | null {
    const p = this.get(personId);
    if (!p) return null;
    const open = this.commitments({ personId, status: 'open' });
    const interactions: InteractionView[] = this.interactions(personId, opts.interactions ?? 5).map((i) => ({
      id: i.id,
      direction: i.direction,
      text: clip(oneLine(i.text), 240),
      source_app: i.source_app,
      occurred_at: i.occurred_at,
    }));
    return {
      id: p.id,
      name: p.name,
      note: p.note,
      relationship: p.relationship,
      aliases: p.aliases,
      youOwe: open.filter((c) => c.owner === 'me'),
      theyOwe: open.filter((c) => c.owner === 'them'),
      interactions,
      items: this.items(personId, opts.items ?? 5),
      created_at: p.created_at,
    };
  }

  // ---- voice samples ----

  /** A sample: pasted in Profile, or a reply the user edited (with where it was written and the draft it came from). */
  addVoice(text: string, origin: VoiceOrigin, from: { channel?: ReplyChannel; personId?: string | null; original?: string } = {}): VoiceSample {
    const t = clip(text.trim(), MAX_TEXT);
    if (!t) throw new Error('Paste a sample first.');
    const row: VoiceSample = {
      id: uuidv7(),
      text: t,
      origin,
      created_at: this.now(),
      channel: from.channel ?? null,
      person_id: from.personId ?? null,
      original: from.original ? clip(from.original.trim(), MAX_TEXT) : null,
    };
    this.store.tx(() => {
      this.db
        .prepare('INSERT INTO voice_samples (id, text, origin, created_at, channel, person_id, original) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.text, row.origin, row.created_at, row.channel, row.person_id, row.original);
      if (origin !== 'pasted') {
        this.db
          .prepare(
            `DELETE FROM voice_samples WHERE origin != 'pasted' AND id NOT IN
               (SELECT id FROM voice_samples WHERE origin != 'pasted' ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
          )
          .run(MAX_INSERTED_VOICE);
      }
    });
    return row;
  }

  voiceSamples(): VoiceSample[] {
    return this.db.prepare('SELECT * FROM voice_samples ORDER BY created_at DESC, rowid DESC').all() as unknown as VoiceSample[];
  }

  deleteVoice(id: string): void {
    this.db.prepare('DELETE FROM voice_samples WHERE id = ?').run(id);
  }

  /**
   * Up to `n` samples for a Reply prompt: pasted ones first, then edited and self-written replies ranked by the
   * same person, then the same relationship (friends, colleagues), then the same kind of
   * platform. Newest first among equals.
   */
  voiceForPrompt(n = 5, to: { channel?: ReplyChannel; personId?: string | null; relationship?: Relationship | null } = {}): string[] {
    const all = this.voiceSamples();
    const pasted = all.filter((v) => v.origin === 'pasted');
    const relOf = new Map(
      (this.db.prepare('SELECT id, relationship FROM people').all() as { id: string; relationship: Relationship | null }[]).map((r) => [r.id, r.relationship]),
    );
    const rank = (v: VoiceSample) =>
      (to.personId && v.person_id === to.personId ? 4 : 0) +
      (to.relationship && v.person_id && relOf.get(v.person_id) === to.relationship ? 2 : 0) +
      (to.channel && v.channel === to.channel ? 1 : 0);
    const edited = all
      .filter((v) => v.origin === 'inserted_edited' || v.origin === 'written')
      .map((v, i) => ({ v, i }))
      .sort((a, b) => rank(b.v) - rank(a.v) || a.i - b.i)
      .map(({ v }) => v);
    return [...pasted, ...edited].slice(0, n).map((v) => v.text);
  }

  /** The newest edited replies with the draft they started from, for the style notes. */
  editedPairs(n = 10): { original: string; text: string }[] {
    return this.voiceSamples()
      .filter((v): v is VoiceSample & { original: string } => v.origin === 'inserted_edited' && Boolean(v.original))
      .slice(0, n)
      .map((v) => ({ original: v.original, text: v.text }));
  }

  // ---- what Reply learned (picks and edits) ----

  addStyleSignals(signals: StyleSignal[], where: { channel: ReplyChannel; personId: string | null }): void {
    if (signals.length === 0) return;
    const at = this.now();
    this.store.tx(() => {
      const insert = this.db.prepare('INSERT INTO style_signals (id, dimension, pole, weight, channel, person_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const sig of signals) insert.run(uuidv7(), sig.dimension, sig.pole, sig.weight, where.channel, where.personId, at);
      this.db.prepare('DELETE FROM style_signals WHERE id NOT IN (SELECT id FROM style_signals ORDER BY at DESC, id DESC LIMIT ?)').run(MAX_STYLE_SIGNALS);
    });
  }

  styleSignals(): StyleSignalRow[] {
    // The relationship is the person's current one, so changing it moves what was learned with them.
    return this.db
      .prepare(
        `SELECT s.dimension, s.pole, s.weight, s.channel, s.person_id, p.relationship, s.at
         FROM style_signals s LEFT JOIN people p ON p.id = s.person_id ORDER BY s.at, s.id`,
      )
      .all() as unknown as StyleSignalRow[];
  }

  /** "Forget this": drops what was learned for one trait in one place, so it starts over. */
  forgetStyle(dimension: StyleDimension, where: { channel: ReplyChannel | null; personId: string | null; relationship?: Relationship | null }): void {
    if (where.personId) this.db.prepare('DELETE FROM style_signals WHERE dimension = ? AND person_id = ?').run(dimension, where.personId);
    else if (where.channel && where.relationship) {
      this.db
        .prepare('DELETE FROM style_signals WHERE dimension = ? AND channel = ? AND person_id IN (SELECT id FROM people WHERE relationship = ?)')
        .run(dimension, where.channel, where.relationship);
    } else if (where.channel) this.db.prepare('DELETE FROM style_signals WHERE dimension = ? AND channel = ?').run(dimension, where.channel);
  }

  styleNotes(): StyleNote[] {
    return this.db.prepare('SELECT * FROM style_notes ORDER BY created_at, rowid').all() as unknown as StyleNote[];
  }

  /** The model's notes replace the previous set. */
  replaceStyleNotes(notes: string[]): StyleNote[] {
    const at = this.now();
    this.store.tx(() => {
      this.db.exec('DELETE FROM style_notes');
      const insert = this.db.prepare('INSERT INTO style_notes (id, text, created_at) VALUES (?, ?, ?)');
      for (const n of notes) insert.run(uuidv7(), clip(oneLine(n), MAX_STYLE_NOTE), at);
    });
    return this.styleNotes();
  }

  /** Removes a note and remembers it, so the next set of notes leaves it out. */
  removeStyleNote(id: string): void {
    const note = this.db.prepare('SELECT text FROM style_notes WHERE id = ?').get(id) as { text: string } | undefined;
    if (!note) return;
    this.store.tx(() => {
      this.db.prepare('DELETE FROM style_notes WHERE id = ?').run(id);
      this.store.setMeta('style_notes_removed', JSON.stringify([...this.removedStyleNotes(), note.text].slice(-20)));
    });
  }

  removedStyleNotes(): string[] {
    try {
      const v = JSON.parse(this.store.getMeta('style_notes_removed') ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
}
