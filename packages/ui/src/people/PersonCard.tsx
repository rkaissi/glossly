// The person card (spec: Who is this): name, aliases, about them, open commitments
// split into "You owe" and "They owe", recent interactions, and saved items that mention
// them. Shared by the overlay's Who panel and the settings window's full record.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Bookmark, CalendarDays, CircleCheck, ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { CommitmentView, PersonCard, Relationship, StylePreferenceView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { InlineConfirm } from '../confirm';
import { Select } from '../controls/Select';
import { TaskCheck } from '../controls/Toggles';
import { appName, firstName, formatDay, formatDue, formatEventTime } from '../dates';
import { KIND_LABEL } from '../kinds';
import { useAction } from '../settings/useAction';
import { RELATIONSHIP_OPTIONS } from './relationship';
import './people.css';

/**
 * Tasks just checked or reopened here, so the row rises in where it lands (Done, or back under
 * You owe), even in a list that only appears with it. The rest of the card comes unanimated
 * (decision 45).
 */
const justMoved = new Map<string, number>();

function CommitmentRow({ c, showPerson }: { c: CommitmentView; showPerson?: boolean }) {
  const { busy, run } = useAction();
  const [leaving, setLeaving] = useState(false);
  const [fresh] = useState(() => {
    const at = justMoved.get(c.id);
    justMoved.delete(c.id);
    return at !== undefined && Date.now() - at < 3000;
  });
  const due = formatDue(c.due_at);
  const done = c.status !== 'open';
  return (
    <li className={`commitment${done ? ' done' : ''}${leaving ? ' leaving' : ''}${fresh ? ' fresh' : ''}`}>
      <TaskCheck
        checked={done !== leaving}
        label={done ? 'Mark as open' : 'Mark as done'}
        disabled={busy || leaving}
        onChange={(on) => {
          // Like the Tasks tab: the check pops, the row slides out, then it moves to the other list
          // (Done or back), where it rises in.
          setLeaving(true);
          setTimeout(() => {
            justMoved.set(c.id, Date.now());
            // The card reloads from the people broadcast after the save; only a failed save keeps
            // the row here, so show it again then.
            void run(() => glossly.invoke('commitments:set-status', { id: c.id, status: on ? 'done' : 'open' }).catch((e: unknown) => {
              justMoved.delete(c.id);
              setLeaving(false);
              throw e;
            }));
          }, 420);
        }}
      />
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

/**
 * What is known about them (decision 84): a list of facts, each reworded or removed on its own
 * (trash morphs into Delete in place, decision 46), and one added at the end. Ask adds to it too.
 * `limit` shows only the first few (the Who card), with Add but no editing.
 */
function Facts({ card, onChange, limit }: { card: PersonCard; onChange: (c: PersonCard) => void; limit?: number }) {
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const shown = limit ? card.facts.slice(0, limit) : card.facts;
  const save = () =>
    void run(async () => {
      if (!editing) return;
      const text = editing.text.trim();
      if (editing.id) onChange(await glossly.invoke('people:fact-update', { personId: card.id, factId: editing.id, text }));
      else if (text) onChange(await glossly.invoke('people:fact-add', { personId: card.id, text }));
      setEditing(null);
    });
  const remove = (factId: string) =>
    void run(async () => {
      onChange(await glossly.invoke('people:fact-remove', { personId: card.id, factId }));
      setPending(null);
    });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
    }
  };
  const field = (
    <div className="fact-edit">
      <input
        autoFocus
        value={editing?.text ?? ''}
        maxLength={300}
        placeholder={`Something about ${firstName(card.name)}`}
        aria-label="Fact"
        disabled={busy}
        onChange={(e) => setEditing((x) => (x ? { ...x, text: e.target.value } : x))}
        onKeyDown={onKeyDown}
      />
      <button className="primary sm" disabled={busy} onClick={save}>
        Save
      </button>
      <button className="ghost sm" onClick={() => setEditing(null)}>
        Cancel
      </button>
    </div>
  );
  const source = (s: PersonCard['facts'][number]['source']) => (s === 'ask' ? 'Ask' : s === 'note' ? 'Note' : 'You');
  return (
    <div className="facts-block">
      {shown.length > 0 && (
        <ul className="facts">
          {shown.map((f) =>
            editing?.id === f.id ? (
              <li key={f.id}>{field}</li>
            ) : (
              <li key={f.id}>
                <span className="grow">{f.text}</span>
                {!limit && (
                  <>
                    <span className="fact-src">
                      {source(f.source)} · {formatDay(f.created_at)}
                    </span>
                    <span className="fact-acts">
                      <button className="icon-btn sm" title="Reword" aria-label="Reword" disabled={busy} onClick={() => setEditing({ id: f.id, text: f.text })}>
                        <Pencil size={14} strokeWidth={1.75} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={`delete-btn${pending === f.id ? ' armed' : ''}`}
                        title={pending === f.id ? 'Remove this' : 'Remove'}
                        aria-label={pending === f.id ? 'Confirm: remove this' : 'Remove'}
                        disabled={busy}
                        onClick={() => (pending === f.id ? remove(f.id) : setPending(f.id))}
                        onBlur={() => setPending(null)}
                      >
                        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                        <span>Delete</span>
                      </button>
                    </span>
                  </>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {limit !== undefined && card.facts.length > limit && <p className="muted small-text">and {card.facts.length - limit} more in the record</p>}
      {editing?.id === null ? (
        field
      ) : (
        <button className="ghost add-note" onClick={() => setEditing({ id: null, text: '' })}>
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          Add something about {firstName(card.name)}
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** How the user knows them. Reply learns per relationship, so changing it moves what was learned with them. */
function RelationshipSelect({ card, onChange }: { card: PersonCard; onChange: (c: PersonCard) => void }) {
  const { busy, error, run } = useAction();
  const set = (relationship: Relationship) => void run(async () => onChange(await glossly.invoke('people:update', { personId: card.id, relationship })));
  return (
    <div className="relationship">
      <span className="muted">Relationship</span>
      <Select<Relationship>
        size="sm"
        label="Relationship"
        value={card.relationship}
        placeholder="Not set"
        disabled={busy}
        onChange={set}
        options={RELATIONSHIP_OPTIONS.map(([value, text]) => ({ value, label: text }))}
      />
      {error && <span className="error">{error}</span>}
    </div>
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
          <Plus size={14} strokeWidth={1.75} aria-hidden />
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
  hasMore,
}: {
  card: PersonCard;
  onChange: (c: PersonCard) => void;
  compact?: boolean;
  removableAliases?: boolean;
  /** The settings record lists more below the card (done tasks), so it isn't empty. */
  hasMore?: boolean;
}) {
  if (compact) return <CompactCard card={card} onChange={onChange} />;
  return (
    <div className="person person-record">
      <div className="person-col">
        <Aliases card={card} onChange={onChange} removable={removableAliases} />
        <RelationshipSelect card={card} onChange={onChange} />
        <div className="person-section">
          <h4>What you know</h4>
          <Facts card={card} onChange={onChange} />
        </div>
        <WritingTo card={card} />
      </div>
      <div className="person-col">
        <Related card={card} hasMore={hasMore} />
      </div>
    </div>
  );
}

/** The Who card (decision 84): the first three facts and the next thing coming up; the rest is in the record. */
function CompactCard({ card, onChange }: { card: PersonCard; onChange: (c: PersonCard) => void }) {
  const next = upcoming(card)[0] ?? null;
  return (
    <div className="person compact">
      <div className="person-head">
        <h2>{card.name}</h2>
        <span className="spacer" />
        <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'people', personId: card.id })}>
          <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
          Open record
        </button>
      </div>
      <Aliases card={card} onChange={onChange} />
      <RelationshipSelect card={card} onChange={onChange} />
      <Facts card={card} onChange={onChange} limit={3} />
      {next && (
        <div className="person-section">
          <h4>Next</h4>
          <ul className="timeline">
            <TimelineRow entry={next} name={card.name} />
          </ul>
        </div>
      )}
    </div>
  );
}

type Entry =
  | { kind: 'event'; at: string; key: string; event: PersonCard['events'][number] }
  | { kind: 'task'; at: string; key: string; task: CommitmentView }
  | { kind: 'message'; at: string; key: string; message: PersonCard['interactions'][number] }
  | { kind: 'saved'; at: string; key: string; item: PersonCard['items'][number] };
type RelatedFilter = 'all' | 'saved' | 'task' | 'event' | 'message';

/** Their events and open tasks, soonest first (tasks with no due day last). */
function upcoming(card: PersonCard): Entry[] {
  const events: Entry[] = card.events.map((e) => ({ kind: 'event', at: e.starts_at, key: `e:${e.id}`, event: e }));
  const tasks: Entry[] = [...card.youOwe, ...card.theyOwe].map((t) => ({ kind: 'task', at: t.due_at ?? '9999', key: `t:${t.id}`, task: t }));
  return [...events, ...tasks].sort((a, b) => a.at.localeCompare(b.at));
}

function TimelineRow({ entry, name }: { entry: Entry; name: string }) {
  switch (entry.kind) {
    case 'event':
      return (
        <li>
          <CalendarDays size={14} strokeWidth={1.75} aria-hidden />
          <span className="grow">{entry.event.title}</span>
          <span className="meta">{formatEventTime(entry.event)}</span>
        </li>
      );
    case 'task':
      return (
        <li>
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden />
          <span className="grow">{entry.task.text}</span>
          <span className="meta">
            {entry.task.owner === 'me' ? 'You owe' : `${firstName(name)} owes`}
            {entry.task.due_at ? ` · ${formatDue(entry.task.due_at).label}` : ''}
          </span>
        </li>
      );
    case 'message':
      return (
        <li>
          {entry.message.direction === 'inbound' ? (
            <ArrowDownLeft size={14} strokeWidth={1.75} aria-label="From them" />
          ) : (
            <ArrowUpRight size={14} strokeWidth={1.75} aria-label="From you" />
          )}
          <span className="grow clip2">{entry.message.text}</span>
          <span className="meta">
            {appName(entry.message.source_app)}
            {entry.message.source_app ? ' · ' : ''}
            {formatDay(entry.message.occurred_at)}
          </span>
        </li>
      );
    case 'saved':
      return (
        <li>
          <Bookmark size={14} strokeWidth={1.75} aria-hidden />
          <span className="grow clip2">
            {entry.item.text}
            {entry.item.why && <span className="muted"> · {entry.item.why}</span>}
          </span>
          <span className="meta">{`${KIND_LABEL[entry.item.kind]} · ${formatDay(entry.item.created_at)}`}</span>
        </li>
      );
  }
}

/**
 * Everything that involves them (decision 84), in one timeline: coming up (events and open tasks,
 * soonest first), then earlier (messages and saved items, newest first), filtered by kind.
 */
function Related({ card, hasMore }: { card: PersonCard; hasMore?: boolean }) {
  const [filter, setFilter] = useState<RelatedFilter>('all');
  const soon = upcoming(card);
  const earlier: Entry[] = [
    ...card.interactions.map((m): Entry => ({ kind: 'message', at: m.occurred_at, key: `m:${m.id}`, message: m })),
    ...card.items.map((it): Entry => ({ kind: 'saved', at: it.created_at, key: `s:${it.id}`, item: it })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const count = (k: Entry['kind']) => [...soon, ...earlier].filter((e) => e.kind === k).length;
  const keep = (e: Entry) => filter === 'all' || e.kind === filter;
  const total = soon.length + earlier.length;
  if (total === 0) {
    return hasMore ? null : <p className="muted small-text">Nothing involves {firstName(card.name)} yet. Tasks, events, messages, and things you save with them show up here.</p>;
  }
  const options: [RelatedFilter, string, number][] = [
    ['all', 'All', total],
    ['saved', 'Saved', count('saved')],
    ['task', 'Tasks', count('task')],
    ['event', 'Events', count('event')],
    ['message', 'Messages', count('message')],
  ];
  const shownSoon = soon.filter(keep);
  const shownEarlier = earlier.filter(keep);
  return (
    <div className="person-section related">
      <h4>Related</h4>
      <div className="filters" role="radiogroup" aria-label="Show">
        {options.map(([v, label, n]) => (
          <button key={v} role="radio" aria-checked={filter === v} className={filter === v ? 'filter on' : 'filter'} onClick={() => setFilter(v)}>
            {label} <span className="muted">{n}</span>
          </button>
        ))}
      </div>
      {shownSoon.length > 0 && (
        <>
          <p className="day-head">Coming up</p>
          <ul className="timeline">
            {shownSoon.map((e) => (
              <TimelineRow key={e.key} entry={e} name={card.name} />
            ))}
          </ul>
        </>
      )}
      {shownEarlier.length > 0 && (
        <>
          <p className="day-head">Earlier</p>
          <ul className="timeline">
            {shownEarlier.map((e) => (
              <TimelineRow key={e.key} entry={e} name={card.name} />
            ))}
          </ul>
        </>
      )}
      {shownSoon.length + shownEarlier.length === 0 && <p className="muted small-text">Nothing of that kind yet.</p>}
    </div>
  );
}

/**
 * How you write to them (decision 84): what Reply and Write here learned about this one person,
 * moved here from Profile. Each can be forgotten.
 */
function WritingTo({ card }: { card: PersonCard }) {
  const [prefs, setPrefs] = useState<StylePreferenceView[]>([]);
  const { busy, run } = useAction();
  useEffect(() => {
    let live = true;
    void glossly.invoke('style:get').then((v) => live && setPrefs(v.preferences.filter((p) => p.scope === 'person' && p.personId === card.id)));
    return () => {
      live = false;
    };
  }, [card.id]);
  if (prefs.length === 0) return null;
  const forget = (p: StylePreferenceView) =>
    void run(async () => {
      const v = await glossly.invoke('style:forget', { dimension: p.dimension, channel: p.channel, personId: p.personId, relationship: p.relationship });
      setPrefs(v.preferences.filter((x) => x.scope === 'person' && x.personId === card.id));
    });
  return (
    <div className="person-section">
      <h4>How you write to {firstName(card.name)}</h4>
      <ul className="facts">
        {prefs.map((p) => (
          <li key={`${p.dimension}:${p.channel}`}>
            <span className="grow">
              {p.label}
              <span className="fact-src">
                {' '}
                · {p.agree} of {p.of}
              </span>
            </span>
            <span className="fact-acts">
              <button className="icon-btn sm" title="Forget" aria-label="Forget" disabled={busy} onClick={() => forget(p)}>
                <X size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
