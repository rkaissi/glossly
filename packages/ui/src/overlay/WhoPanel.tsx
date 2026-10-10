import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Info, UserRoundPlus } from 'lucide-react';
import type { DetectedPerson, OverlayState, PersonCard, WhoEntry, WhoView } from '@glossly/core/api';
import type { Relationship } from '@glossly/core/api';
import { RELATIONSHIP_OPTIONS } from '../people/relationship';
import { glossly } from '../bridge';
import { firstName } from '../dates';
import { PersonCardView } from '../people/PersonCard';
import { useAction } from '../settings/useAction';

const label = (d: DetectedPerson) => d.name ?? d.email ?? (d.handle ? `@${d.handle}` : 'Someone');

/** Spec: never merge automatically. "Is this the same Sam?" with both records side by side. */
function SameQuestion({ entry, onResolved }: { entry: WhoEntry; onResolved: (card: PersonCard) => void }) {
  const d = entry.detected;
  const p = entry.person!;
  const { busy, error, run } = useAction();
  const open = p.youOwe.length + p.theyOwe.length;
  return (
    <div className="same">
      <h2>Is this the same {firstName(p.name)}?</h2>
      <div className="same-pair">
        <div className="same-card">
          <div className="same-label">In this selection</div>
          <strong>{label(d)}</strong>
          {d.name && d.email && <span className="muted">{d.email}</span>}
          {d.handle && <span className="muted">@{d.handle}</span>}
        </div>
        <div className="same-card">
          <div className="same-label">In your people</div>
          <strong>{p.name}</strong>
          {p.aliases.length > 0 && <span className="muted">{p.aliases.map((a) => a.value).join(', ')}</span>}
          {p.note && <span className="muted clip2">{p.note}</span>}
          {open > 0 && <span className="muted">{open} open</span>}
        </div>
      </div>
      <div className="row-tight">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              onResolved(
                await glossly.invoke('people:confirm-same', {
                  personId: p.id,
                  ...(d.name && { name: d.name }),
                  ...(d.email && { email: d.email }),
                  ...(d.handle && { handle: d.handle }),
                }),
              ),
            )
          }
        >
          Same person
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              onResolved(
                await glossly.invoke('people:create', {
                  name: d.name ?? d.email ?? d.handle ?? 'Unnamed',
                  ...(d.email && { email: d.email }),
                  ...(d.handle && { handle: d.handle }),
                }),
              ),
            )
          }
        >
          Different person
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}

function noteFrom(detected: DetectedPerson | null): string {
  return [detected?.detail, detected?.relation].filter((s) => s && s.trim()).join('. ');
}

/** Spec: no match, so offer "Create person" with the detected name, email, handle, and note prefilled. */
function CreatePerson({ detected, onCreated }: { detected: DetectedPerson | null; onCreated: (card: PersonCard) => void }) {
  const [name, setName] = useState(detected?.name ?? '');
  const [email, setEmail] = useState(detected?.email ?? '');
  const [handle, setHandle] = useState(detected?.handle ?? '');
  const [note, setNote] = useState(noteFrom(detected));
  // The model's guess, editable; empty is unknown.
  const [relationship, setRelationship] = useState<Relationship | ''>(detected?.relationship ?? '');
  const { busy, error, run } = useAction();
  const create = () =>
    void run(async () => {
      if (!name.trim()) throw new Error('Type a name first.');
      onCreated(
        await glossly.invoke('people:create', {
          name: name.trim(),
          ...(email.trim() && { email: email.trim() }),
          ...(handle.trim() && { handle: handle.trim().replace(/^@+/, '') }),
          ...(note.trim() && { note: note.trim() }),
          relationship: relationship || null,
        }),
      );
    });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create();
    }
  };
  return (
    <div className="create-person" onKeyDown={onKeyDown}>
      <h2>{detected ? `${label(detected)} isn't in your people yet` : 'Add a person'}</h2>
      <div className="form-grid">
        <input value={name} placeholder="Name" aria-label="Name" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        <input value={email} placeholder="Email (optional)" aria-label="Email" spellCheck={false} onChange={(e) => setEmail(e.target.value)} />
        <input value={handle} placeholder="Handle (optional)" aria-label="Handle" spellCheck={false} onChange={(e) => setHandle(e.target.value)} />
        <input className="wide" value={note} placeholder="How do you know them? (optional)" aria-label="Note" onChange={(e) => setNote(e.target.value)} />
        <select value={relationship} aria-label="Relationship" onChange={(e) => setRelationship(e.target.value as Relationship | '')}>
          <option value="">Relationship: unknown</option>
          {RELATIONSHIP_OPTIONS.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </div>
      <div className="row-tight">
        <button className="primary" disabled={busy || !name.trim()} onClick={create}>
          <UserRoundPlus size={15} strokeWidth={1.75} aria-hidden />
          Create person
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}

/** Who is this: one tab per person found in the selection, each with their card or a way to add them. */
export function WhoPanel({ s }: { s: OverlayState }) {
  const [view, setView] = useState<WhoView | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    glossly
      .invoke('who:get', { sessionId: s.sessionId })
      .then((v) => live && setView(v))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [s.sessionId]);

  const turnOffLocalOnly = () => {
    setView(null);
    setFailed(false);
    void glossly
      .invoke('settings:set', { key: 'localOnly', value: false })
      .then(() => glossly.invoke('who:get', { sessionId: s.sessionId }))
      .then((v) => setView(v))
      .catch(() => setFailed(true));
  };

  const entries = view?.entries ?? [];
  const entry = entries[Math.min(index, entries.length - 1)];

  const resolve = (card: PersonCard) =>
    setView((v) => v && { ...v, entries: v.entries.map((e) => (e === entry ? { ...e, match: 'exact' as const, score: null, person: card } : e)) });

  // A change made elsewhere (a commitment marked done in Settings) refreshes the cards shown.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(
    () =>
      glossly.on('people:changed', () => {
        const v = viewRef.current;
        if (!v) return;
        void Promise.all(
          v.entries.map((e) => (e.match === 'exact' && e.person ? glossly.invoke('people:card', { personId: e.person.id }) : Promise.resolve(null))),
        ).then((cards) =>
          setView((cur) => {
            if (!cur) return cur;
            const entries = cur.entries.map((e, i) => {
              const c = cards[i];
              // The overlay card shows the last 5 of each, like who:get.
              return c && e.match === 'exact' ? { ...e, person: { ...c, interactions: c.interactions.slice(0, 5), items: c.items.slice(0, 5) } } : e;
            });
            return { ...cur, entries };
          }),
        );
      }),
    [],
  );

  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (s.keyboard) panel.current?.focus();
  }, [s.keyboard]);

  const onKeyDown = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === 'Tab' && !typing && entries.length > 1) {
      e.preventDefault();
      const n = entries.length;
      setIndex((i) => (i + (e.shiftKey ? n - 1 : 1)) % n);
    }
  };

  return (
    <div className="panel who" tabIndex={-1} onKeyDown={onKeyDown} ref={panel}>
      {view && !view.identitySet && (
        <div className="inline-note">
          <Info size={14} strokeWidth={1.75} aria-hidden />
          <span>Add your name so Glossly can leave you out of this list.</span>
          <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'profile' })}>
            Add your name
          </button>
        </div>
      )}
      {view?.local === 'local_only' && (
        <div className="inline-note">
          <Info size={14} strokeWidth={1.75} aria-hidden />
          <span>Local only is on, so this list is from the text only.</span>
          <button className="ghost" onClick={turnOffLocalOnly}>
            Turn off Local only
          </button>
        </div>
      )}
      {view?.local === 'no_model' && (
        <div className="inline-note">
          <Info size={14} strokeWidth={1.75} aria-hidden />
          <span>No model is set up, so this list is from the text only.</span>
          <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>
            Add a key
          </button>
        </div>
      )}
      {view?.local === 'model_failed' && (
        <div className="inline-note">
          <Info size={14} strokeWidth={1.75} aria-hidden />
          <span>The model didn't answer, so this list is from the text only.</span>
        </div>
      )}
      {failed && <p className="error">Could not look up the people in this selection.</p>}
      {!view && !failed && <p className="muted">Looking up people…</p>}

      {entries.length > 1 && (
        <div className="chips" role="tablist" aria-label="People in the selection">
          {entries.map((e, i) => (
            <button
              key={e.key}
              role="tab"
              aria-selected={e === entry}
              className={`chip${e === entry ? ' selected' : ''}`}
              tabIndex={-1}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => setIndex(i)}
            >
              {e.person && e.match === 'exact' ? e.person.name : label(e.detected)}
              {e.match === 'fuzzy' ? '?' : e.match === 'none' ? ' (new)' : ''}
            </button>
          ))}
        </div>
      )}

      <div className="who-body" key={entry?.key}>
        {view && entries.length === 0 && (
          <>
            <p className="muted">No names, emails, or handles found in this selection.</p>
            <CreatePerson detected={null} onCreated={(card) => setView({ ...view, entries: [{ key: 'new', detected: { name: card.name, email: null, handle: null, role: 'mentioned', knownId: card.id }, match: 'exact', score: null, person: card }] })} />
          </>
        )}
        {entry?.match === 'exact' && entry.person && <PersonCardView compact card={entry.person} onChange={resolve} />}
        {entry?.match === 'fuzzy' && entry.person && <SameQuestion entry={entry} onResolved={resolve} />}
        {entry?.match === 'none' && <CreatePerson detected={entry.detected} onCreated={resolve} />}
      </div>

      {s.keyboard && (
        <div className="panel-foot">
          <span className="spacer" />
          <span>
            {entries.length > 1 && (
              <>
                <kbd>Tab</kbd> next person ·{' '}
              </>
            )}
            <kbd>Esc</kbd> back
          </span>
        </div>
      )}
    </div>
  );
}
