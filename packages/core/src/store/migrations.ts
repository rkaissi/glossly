/**
 * Versioned migrations, applied in order and tracked with PRAGMA user_version. Never edit a
 * shipped migration; add a new one. The vec0 table is created separately (see Store) because
 * its dimension depends on the embedding model.
 */
export const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

  CREATE TABLE models (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider, model_id)
  );

  CREATE TABLE collections (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    collection_id TEXT REFERENCES collections(id),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    why TEXT,
    source_app TEXT, window_title TEXT,
    data_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX items_collection ON items(collection_id);
  CREATE INDEX items_created ON items(created_at);

  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    canonical TEXT NOT NULL,
    display TEXT NOT NULL,
    UNIQUE (kind, canonical)
  );

  CREATE TABLE item_entities (
    item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
    entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, entity_id)
  );
  CREATE INDEX item_entities_entity ON item_entities(entity_id);

  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    entity_id TEXT UNIQUE REFERENCES entities(id),
    name TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE person_aliases (
    person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE (kind, value)
  );

  CREATE TABLE interactions (
    id TEXT PRIMARY KEY,
    person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    text TEXT NOT NULL,
    source_app TEXT,
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE commitments (
    id TEXT PRIMARY KEY,
    person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    source_interaction_id TEXT REFERENCES interactions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE voice_samples (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX events_kind_at ON events(kind, at);
  `,
  /* 2: Phase 2, people layer. notified_at marks a commitment whose due-date notification was shown. */ `
  ALTER TABLE commitments ADD COLUMN notified_at TEXT;
  CREATE INDEX commitments_person ON commitments(person_id, status);
  CREATE INDEX commitments_due ON commitments(status, due_at);
  CREATE INDEX interactions_person ON interactions(person_id, occurred_at);
  CREATE INDEX person_aliases_person ON person_aliases(person_id);
  `,
  /* 3: Reply learns from edits and picks. Voice samples remember where they were written and the
     draft they were edited from; unedited inserts are the model's own writing, so they go. */ `
  ALTER TABLE voice_samples ADD COLUMN channel TEXT;
  ALTER TABLE voice_samples ADD COLUMN person_id TEXT;
  ALTER TABLE voice_samples ADD COLUMN original TEXT;
  DELETE FROM voice_samples WHERE origin = 'inserted';
  CREATE TABLE style_signals (
    id TEXT PRIMARY KEY,
    dimension TEXT NOT NULL,
    pole TEXT NOT NULL,
    weight REAL NOT NULL,
    channel TEXT NOT NULL,
    person_id TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX style_signals_at ON style_signals(at);
  CREATE TABLE style_notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL);
  `,
  /* 4: How the user knows each person (friend, colleague, ...; null is unknown), so Reply can
     learn per relationship. Platforms became kinds: the old "chat" can't be split into work
     chat and messaging after the fact, so it counts as messaging. */ `
  ALTER TABLE people ADD COLUMN relationship TEXT;
  UPDATE style_signals SET channel = 'messaging' WHERE channel = 'chat';
  UPDATE voice_samples SET channel = 'messaging' WHERE channel = 'chat';
  `,
  /* 5: Calendar events (Step 19.2, decision 37), on this computer only. starts_at is a day for an
     all-day event, else a timestamp; attendees is a JSON list of names as written; the saved
     people among them are linked. notified_at marks the reminder before it starts. */ `
  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    attendees TEXT NOT NULL DEFAULT '[]',
    source_app TEXT,
    created_at TEXT NOT NULL,
    notified_at TEXT
  );
  CREATE INDEX calendar_events_start ON calendar_events(starts_at);
  CREATE TABLE calendar_event_people (
    event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, person_id)
  );
  CREATE INDEX calendar_event_people_person ON calendar_event_people(person_id);
  `,
  /* 6: When a task was finished (Step 20.2), for the Tasks tab's Completed list. Tasks finished
     before this have none. */ `
  ALTER TABLE commitments ADD COLUMN completed_at TEXT;
  `,
  /* 7: Items saved while no model could find their people and places (Local only with no local
     model, or no key yet), so they can be offered a backfill later (Step 20.3, decision 44). */ `
  ALTER TABLE items ADD COLUMN entities_pending INTEGER NOT NULL DEFAULT 0;
  `,
  /* 8: Reply stops counting contractions (decision 49): the old votes read "Im" and "cant" as
     dropping contractions and a pick without one as a choice, so they all go. Style notes get the
     kind of platform they hold for (null: everywhere). */ `
  DELETE FROM style_signals WHERE dimension = 'contractions';
  ALTER TABLE style_notes ADD COLUMN channel TEXT;
  `,
  /* 9: The model call log (decision 61): every try on a model with its prompt and answer, kept
     30 days and only while the user has the log on (Privacy). Not exported. */ `
  CREATE TABLE llm_calls (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    fallback_from TEXT,
    status TEXT NOT NULL,
    error TEXT,
    ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    reasoning_tokens INTEGER,
    prompt TEXT NOT NULL,
    response TEXT
  );
  CREATE INDEX llm_calls_at ON llm_calls(at);
  `,
  /* 10: Which people, tasks, and events have a vector in context_vectors, and the hash of the text
     each was embedded from, so a row is embedded again only when that text changes (decision 77).
     Derived data: cleared with the data, never exported. */ `
  CREATE TABLE context_docs (
    doc_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    hash TEXT NOT NULL,
    embedded_at TEXT NOT NULL
  );
  `,
];

/** Tables included in export, in foreign-key-safe delete order. */
export const DATA_TABLES = [
  'calendar_event_people',
  'calendar_events',
  'item_entities',
  'commitments',
  'interactions',
  'person_aliases',
  'people',
  'entities',
  'items',
  'collections',
  'voice_samples',
  'style_signals',
  'style_notes',
  'events',
  'models',
  'settings',
] as const;

/** Logs kept on this computer only: cleared with the data, never exported (decision 61). */
export const LOG_TABLES = ['llm_calls'] as const;

/** Built from the user's data and rebuilt from it: cleared with the data, never exported (decision 77). */
export const DERIVED_TABLES = ['context_docs'] as const;

/** What "Delete all data" clears: everything but settings and the model list (and meta). */
export const USER_DATA_TABLES = [...DATA_TABLES.filter((t) => t !== 'models' && t !== 'settings'), ...LOG_TABLES, ...DERIVED_TABLES];
