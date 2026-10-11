// The person card (spec: Who is this): name, aliases, about them, open commitments
// split into "You owe" and "They owe", recent interactions, and saved items that mention
// them. Shared by the overlay's Who panel and the settings window's full record.
import { useState, type KeyboardEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Bookmark, Check, ExternalLink, Pencil, Plus, X } from 'lucide-react';
import type { CommitmentView, PersonCard, Relationship } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { appName, firstName, formatDay, formatDue } from '../dates';
import { useAction } from '../settings/useAction';
import { RELATIONSHIP_OPTIONS } from './relationship';
import './people.css';

function CommitmentRow({ c, showPerson }: { c: CommitmentView; showPerson?: boolean }) {
  const { busy, run } = useAction();
  const due = formatDue(c.due_at);
  const done = c.status !== 'open';
  return (
    <li className={`commitment${done ? ' done' : ''}`}>
      <button
        className="check"
        title={done ? 'Mark as open' : 'Mark as done'}
        aria-label={done ? 'Mark as open' : 'Mark as done'}
        disabled={busy}
        onClick={() => void run(() => glossly.invoke('commitments:set-status', { id: c.id, status: done ? 'open' : 'done' }))}
      >
        {done && <Check size={12} strokeWidth={2.5} aria-hidden />}
      </button>
      <span className="grow">
        {c.text}
        {showPerson && c.person_name && <span className="muted"> · {c.owner === 'me' ? `to ${c.person_name}` : `from ${c.person_name}`}</span>}
      </span>
      <span className={`due${due.overdue && !done ? ' overdue' : ''}`}>{due.label}</span>
    </li>
  );
}

export function CommitmentList({ items, showPerson }: { items: CommitmentView[]; showPerson?: boolean }) {
  return (
    <ul className="commitments">
      {items.map((c) => (
        <CommitmentRow key={c.id} c={c} showPerson={showPerson} />
      ))}
    </ul>
  );
}

function Note({ card, onChange }: { card: PersonCard; onChange: (c: PersonCard) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.note ?? '');
  const { busy, error, run } = useAction();
  const save = () =>
    void run(async () => {
      onChange(await glossly.invoke('people:update', { personId: card.id, note: text.trim() || null }));
      setEditing(false);
    });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
      setText(card.note ?? '');
    }
  };
  if (!editing) {
    return card.note ? (
      <div className="note">
        <p>{card.note}</p>
        <button className="ghost icon-only" title="Edit note" aria-label="Edit note" onClick={() => setEditing(true)}>
          <Pencil size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    ) : (
      <button className="ghost add-note" onClick={() => setEditing(true)}>
        <Plus size={14} strokeWidth={1.75} aria-hidden />
        About {firstName(card.name)}
      </button>
    );
  }
  return (
    <div className="note-edit">
      <textarea autoFocus rows={2} value={text} maxLength={1000} placeholder="About this person" aria-label="About" onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
      <div className="row-tight">
        <button className="primary" disabled={busy} onClick={save}>
          Save note
        </button>
        <button className="ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}

/** How the user knows them. Reply learns per relationship, so changing it moves what was learned with them. */
function RelationshipSelect({ card, onChange }: { card: PersonCard; onChange: (c: PersonCard) => void }) {
  const { busy, error, run } = useAction();
  const set = (relationship: Relationship) => void run(async () => onChange(await glossly.invoke('people:update', { personId: card.id, relationship })));
  return (
    <label className="relationship">
      <span className="muted">Relationship</span>
      <select value={card.relationship ?? ''} disabled={busy} aria-label="Relationship" onChange={(e) => set(e.target.value as Relationship)}>
        {!card.relationship && (
          <option value="" disabled>
            Not set
          </option>
        )}
        {RELATIONSHIP_OPTIONS.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      {error && <span className="error">{error}</span>}
    </label>
  );
}

function Aliases({ card, onChange, removable }: { card: PersonCard; onChange: (c: PersonCard) => void; removable?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState<PersonCard['aliases'][number] | null>(null);
  const { busy, error, run } = useAction();
  const add = () =>
    void run(async () => {
      if (!value.trim()) return setAdding(false);
      onChange(await glossly.invoke('people:alias-add', { personId: card.id, value: value.trim() }));
      setValue('');
      setAdding(false);
    });
  const remove = (a: PersonCard['aliases'][number]) =>
    void run(async () => {
      onChange(await glossly.invoke('people:alias-remove', { personId: card.id, kind: a.kind, value: a.value }));
      setPending(null);
    });
  const label = (a: PersonCard['aliases'][number]) => (a.kind === 'handle' ? `@${a.value}` : a.value);
  return (
    <div className="aliases">
      {card.aliases.map((a) => (
        <span key={`${a.kind}:${a.value}`} className="alias" title={a.kind}>
          {label(a)}
          {removable && (
            <button
              className="chip-x danger"
              title={`Remove ${label(a)}`}
              aria-label={`Remove ${label(a)}`}
              disabled={busy}
              onClick={() => setPending(a)}
            >
              <X size={11} strokeWidth={2} aria-hidden />
            </button>
          )}
        </span>
      ))}
      {pending && removable && (
        <InlineConfirm
          prompt={`Remove ${label(pending)}?`}
          confirm="Remove"
          busy={busy}
          onConfirm={() => remove(pending)}
          onCancel={() => setPending(null)}
        />
      )}
      {adding ? (
        <input
          className="alias-input"
          autoFocus
          value={value}
          placeholder="Email, @handle, or name"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setAdding(false);
            }
          }}
        />
      ) : (
        <button className="ghost alias-add" onClick={() => setAdding(true)}>
          <Plus size={13} strokeWidth={1.75} aria-hidden />
          Alias
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/**
 * `compact` (the overlay) shows a header with "Open record"; the settings record renders its
 * own header and passes `removableAliases`.
 */
export function PersonCardView({
  card,
  onChange,
  compact,
  removableAliases,
}: {
  card: PersonCard;
  onChange: (c: PersonCard) => void;
  compact?: boolean;
  removableAliases?: boolean;
}) {
  const empty = !card.youOwe.length && !card.theyOwe.length && !card.interactions.length && !card.items.length;
  return (
    <div className={`person${compact ? ' compact' : ''}`}>
      {compact && (
        <div className="person-head">
          <h2>{card.name}</h2>
          <span className="spacer" />
          <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'people', personId: card.id })}>
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
            Open record
          </button>
        </div>
      )}
      <Aliases card={card} onChange={onChange} removable={removableAliases} />
      <RelationshipSelect card={card} onChange={onChange} />
      <Note card={card} onChange={onChange} />

      {card.youOwe.length > 0 && (
        <div className="person-section">
          <h4>You owe</h4>
          <CommitmentList items={card.youOwe} />
        </div>
      )}
      {card.theyOwe.length > 0 && (
        <div className="person-section">
          <h4>{firstName(card.name)} owes you</h4>
          <CommitmentList items={card.theyOwe} />
        </div>
      )}
      {card.interactions.length > 0 && (
        <div className="person-section">
          <h4>Recent</h4>
          <ul className="timeline">
            {card.interactions.map((i) => (
              <li key={i.id}>
                {i.direction === 'inbound' ? (
                  <ArrowDownLeft size={14} strokeWidth={1.75} aria-label="From them" />
                ) : (
                  <ArrowUpRight size={14} strokeWidth={1.75} aria-label="From you" />
                )}
                <span className="grow clip2">{i.text}</span>
                <span className="meta">
                  {appName(i.source_app)}
                  {i.source_app ? ' · ' : ''}
                  {formatDay(i.occurred_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.items.length > 0 && (
        <div className="person-section">
          <h4>Saved</h4>
          <ul className="timeline">
            {card.items.map((it) => (
              <li key={it.id}>
                <Bookmark size={14} strokeWidth={1.75} aria-hidden />
                <span className="grow clip2">
                  {it.text}
                  {it.why && <span className="muted"> · {it.why}</span>}
                </span>
                <span className="meta">
                  {it.collection ? `${it.collection} · ` : ''}
                  {formatDay(it.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {empty && <p className="muted small-text">Nothing saved about {firstName(card.name)} yet. Promises and replies you save with them show up here.</p>}
    </div>
  );
}
