import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { CommitmentView, PersonCard, PersonSummary } from '@glossly/core/api';
import { glossly } from '../bridge';
import { Select } from '../controls/Select';
import { formatDay } from '../dates';
import { CommitmentList, PersonCardView } from '../people/PersonCard';
import { useAction } from './useAction';
import { useLive } from './useLive';

function PeopleList() {
  const [query, setQuery] = useState('');
  const people = useLive(useCallback(() => glossly.invoke('people:list', { query }), [query]));
  return (
    <section>
      <h2>People</h2>
      <p className="muted">
        Everyone here was added by you, from "Who is this", a task you saved, or a reply you inserted. Nothing is looked up online. Open tasks and
        events are in the <a href="#tasks">Tasks</a> and <a href="#calendar">Calendar</a> tabs.
      </p>

      <h3>Everyone</h3>
      <div className="search">
        <Search size={14} strokeWidth={1.75} aria-hidden />
        <input value={query} placeholder="Search names, emails, and handles" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {people && people.length > 0 ? (
        <ul className="list people-list">
          {people.map((p) => (
            <li key={p.id}>
              <a href={`#people/${p.id}`} className="person-link">
                <span className="grow">
                  <strong>{p.name}</strong>
                  {p.aliases.length > 0 && <span className="muted small"> · {p.aliases.join(', ')}</span>}
                  {p.note && <span className="muted small block clip1">{p.note}</span>}
                </span>
                {p.open > 0 && <span className="tag">{p.open} open</span>}
                {p.last_seen && <span className="muted small">{formatDay(p.last_seen)}</span>}
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">
          {!people ? 'Loading…' : query ? 'No one matches.' : 'No people yet. Select a message and open "Who is this" to add someone.'}
        </p>
      )}
    </section>
  );
}

function Rename({ card, onChange }: { card: PersonCard; onChange: (c: PersonCard) => void }) {
  const [name, setName] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  if (name === null) {
    return (
      <div className="record-head">
        <h2>{card.name}</h2>
        <button className="ghost" onClick={() => setName(card.name)}>
          Rename
        </button>
      </div>
    );
  }
  const save = () =>
    void run(async () => {
      onChange(await glossly.invoke('people:update', { personId: card.id, name }));
      setName(null);
    });
  return (
    <div className="record-head">
      <input
        autoFocus
        value={name}
        maxLength={100}
        aria-label="Name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setName(null);
        }}
      />
      <button className="primary" disabled={busy || !name.trim()} onClick={save}>
        Save
      </button>
      <button onClick={() => setName(null)}>Cancel</button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

function Merge({ card }: { card: PersonCard }) {
  const people = useLive(useCallback(() => glossly.invoke('people:list', {}), []));
  const [other, setOther] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const others = (people ?? []).filter((p: PersonSummary) => p.id !== card.id);
  const pick = others.find((p) => p.id === other);
  if (others.length === 0) return null;
  return (
    <div className="field">
      <div className="field-label">
        <strong>Same person as someone else?</strong>
        <p className="muted small">Merging moves their aliases, messages, and commitments into {card.name}'s record and removes the other record.</p>
      </div>
      <div className="row">
        <Select
          label="Person to merge"
          value={other || null}
          placeholder="Pick a person…"
          onChange={(id) => {
            setOther(id);
            setConfirming(false);
          }}
          options={others.map((p) => ({ value: p.id, label: p.name, hint: p.aliases.length ? p.aliases.join(', ') : undefined }))}
        />
        <button className="danger" disabled={!pick || busy} onClick={() => setConfirming(true)}>
          Merge…
        </button>
      </div>
      {confirming && pick && (
        <div className="confirm">
          <span className="grow">
            Merge {pick.name} into {card.name}? This can't be undone.
          </span>
          <button className="danger" disabled={busy} onClick={() => void run(() => glossly.invoke('people:merge', { keepId: card.id, dropId: pick.id }))}>
            Merge
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function Delete({ card }: { card: PersonCard }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const del = () =>
    void run(async () => {
      await glossly.invoke('people:delete', { personId: card.id });
      location.hash = 'people';
    });
  return (
    <div className="field">
      <div className="field-label">
        <strong>Delete {card.name}</strong>
        <p className="muted small">Removes their aliases, messages, and commitments. Items you saved that mention them stay.</p>
      </div>
      {confirming ? (
        <div className="confirm">
          <span className="grow">Delete {card.name}? This can't be undone.</span>
          <button className="danger" disabled={busy} onClick={del}>
            Delete
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <div className="row">
          <button className="danger" onClick={() => setConfirming(true)}>
            Delete person…
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function PersonRecord({ personId }: { personId: string }) {
  const loaded = useLive(useCallback(() => glossly.invoke('people:card', { personId }), [personId]));
  const all = useLive(useCallback(() => glossly.invoke('commitments:list', {}), []));
  const [card, setCard] = useState<PersonCard | null>(null);
  useEffect(() => setCard(loaded ?? null), [loaded]);
  const closed = (all ?? []).filter((c: CommitmentView) => c.person_id === personId && c.status !== 'open');

  return (
    <section>
      <a href="#people" className="back-link">
        <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
        People
      </a>
      {loaded === undefined ? (
        <p className="muted">Loading…</p>
      ) : !card ? (
        <p className="muted">This person no longer exists.</p>
      ) : (
        <>
          <Rename card={card} onChange={setCard} />
          <p className="muted small">Added {formatDay(card.created_at)}</p>
          <div className="field">
            <PersonCardView card={card} onChange={setCard} removableAliases />
          </div>
          {closed.length > 0 && (
            <>
              <h3>Done</h3>
              <div className="field">
                <CommitmentList items={closed} />
              </div>
            </>
          )}
          <h3>Manage</h3>
          <Merge card={card} />
          <Delete card={card} />
        </>
      )}
    </section>
  );
}

export function PeopleTab({ personId }: { personId: string | null }) {
  return personId ? <PersonRecord key={personId} personId={personId} /> : <PeopleList />;
}
