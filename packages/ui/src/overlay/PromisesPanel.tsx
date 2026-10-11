import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ExternalLink, Info, RotateCcw } from 'lucide-react';
import type { OverlayState, PromiseRow, PromiseSaveRow, PromisesByRules, PromisesResult } from '@glossly/core/api';
import { glossly } from '../bridge';
import { formatDue } from '../dates';
import { PersonFields } from '../people/PersonForm';
import { draftToCreate, type PersonDraft } from '../people/draft';

/** Which person a row is saved with: the matched record, a new one from the name, or nobody. */
type PersonChoice = 'match' | 'new' | 'none';

interface Draft extends PromiseRow {
  person: PersonChoice;
}

const initialChoice = (r: PromiseRow): PersonChoice => (r.match ? 'match' : r.person_name ? 'new' : 'none');

/** A new person starts from what Who's reader found (email, handle, note, relationship), else just the name. */
function draftForRow(r: PromiseRow): PersonDraft {
  return {
    name: r.person_name ?? '',
    email: r.details?.email ?? '',
    handle: r.details?.handle ?? '',
    note: r.details?.note ?? '',
    relationship: r.details?.relationship ?? 'other',
  };
}

/** A new person is created with the fields as the user left them in "New people" (the same fields as Who's Create person). */
function toSave(d: Draft, people: Record<string, PersonDraft>): PromiseSaveRow {
  let person: PromiseSaveRow['person'] = null;
  if (d.person === 'match' && d.match) person = { kind: 'existing', id: d.match.personId };
  else if (d.person === 'new' && d.person_name) {
    const f = draftToCreate(people[d.person_name] ?? draftForRow(d));
    person = { kind: 'new', name: f.name || d.person_name, email: f.email ?? null, handle: f.handle ?? null, note: f.note ?? null, relationship: f.relationship };
  }
  return { owner: d.owner, text: d.text.trim(), due_at: d.due_at, person };
}

/**
 * The people the selected rows will create, once each, with the same fields as adding a person
 * in Who is this (prefilled from Who's reader). They are created when the promises are saved.
 */
function NewPeople({ rows, people, onChange }: { rows: Draft[]; people: Record<string, PersonDraft>; onChange: (key: string, d: PersonDraft) => void }) {
  const seen = new Map<string, Draft>();
  for (const r of rows) if (r.selected && r.person === 'new' && r.person_name && !seen.has(r.person_name)) seen.set(r.person_name, r);
  if (seen.size === 0) return null;
  return (
    <div className="new-people">
      <h4>New people</h4>
      <ul>
        {[...seen.values()].map((r) => {
          const key = r.person_name!;
          return (
            <li key={key}>
              <PersonFields value={people[key] ?? draftForRow(r)} onChange={(d) => onChange(key, d)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; result: Extract<PromisesResult, { ok: false }> }
  | { kind: 'review' }
  | { kind: 'saving' }
  | { kind: 'saved'; saved: number; created: number };

function Row({
  d,
  highlight,
  onChange,
  onFocusRow,
}: {
  d: Draft;
  highlight: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onFocusRow: () => void;
}) {
  const due = formatDue(d.due_at);
  return (
    <li className={`promise${d.selected ? '' : ' off'}${highlight ? ' highlight' : ''}`} onFocus={onFocusRow}>
      <button
        className={`check${d.selected ? ' on' : ''}`}
        role="checkbox"
        aria-checked={d.selected}
        aria-label={d.selected ? 'Skip this one' : 'Keep this one'}
        tabIndex={-1}
        onClick={() => onChange({ selected: !d.selected })}
      >
        {d.selected && <Check size={12} strokeWidth={2.5} aria-hidden />}
      </button>
      <div className="promise-body">
        <input className="promise-text" value={d.text} maxLength={300} aria-label="What" spellCheck={false} onChange={(e) => onChange({ text: e.target.value })} />
        <div className="promise-meta">
          <button
            className="owner"
            title="Switch who owes it"
            tabIndex={-1}
            onClick={() => onChange({ owner: d.owner === 'me' ? 'them' : 'me' })}
          >
            {d.owner === 'me' ? 'You owe' : 'They owe'}
          </button>
          <select
            value={d.person}
            aria-label="Person"
            tabIndex={-1}
            onChange={(e) => onChange({ person: e.target.value as PersonChoice })}
          >
            {d.match && <option value="match">{d.match.kind === 'fuzzy' ? `${d.match.name}?` : d.match.name}</option>}
            {d.person_name && <option value="new">New person: {d.person_name}</option>}
            <option value="none">No one</option>
          </select>
          <span className="spacer" />
          <label className={`due-edit${due.overdue ? ' overdue' : ''}`} title={d.due_phrase ? `"${d.due_phrase}"` : 'No deadline in the text'}>
            <span>{d.due_at ? due.label : d.due_phrase ? `No date ("${d.due_phrase}")` : 'No date'}</span>
            <input
              type="date"
              aria-label="Due date"
              tabIndex={-1}
              value={d.due_at?.slice(0, 10) ?? ''}
              onChange={(e) => onChange({ due_at: e.target.value || null })}
            />
          </label>
        </div>
      </div>
    </li>
  );
}

/**
 * What did I promise: candidate commitments in both directions. The user toggles rows, fixes
 * a name or date if needed, and Enter saves the selected ones.
 */
export function PromisesPanel({ s }: { s: OverlayState }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [rows, setRows] = useState<Draft[]>([]);
  const [meta, setMeta] = useState<{ author: string | null; authorIsMe: boolean; identitySet: boolean; byRules: PromisesByRules } | null>(null);
  const [hl, setHl] = useState(0);
  const [people, setPeople] = useState<Record<string, PersonDraft>>({});
  const panel = useRef<HTMLDivElement>(null);

  const extract = async () => {
    setPhase({ kind: 'loading' });
    const r = await glossly.invoke('promises:extract', { sessionId: s.sessionId }).catch(
      (): PromisesResult => ({ ok: false, code: 'provider', message: 'The model call failed.' }),
    );
    if (!r.ok) {
      if (r.code !== 'aborted') setPhase({ kind: 'error', result: r });
      return;
    }
    setRows(r.rows.map((row) => ({ ...row, person: initialChoice(row) })));
    setMeta({ author: r.author, authorIsMe: r.authorIsMe, identitySet: r.identitySet, byRules: r.byRules });
    setHl(0);
    setPhase({ kind: 'review' });
  };

  useEffect(() => {
    void extract();
    // One extraction per panel; the session id never changes inside it.
  }, []);

  useEffect(() => {
    if (s.keyboard) panel.current?.focus();
  }, [s.keyboard, phase.kind]);

  const selected = rows.filter((r) => r.selected && r.text.trim());
  const patch = (i: number, p: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = async () => {
    if (phase.kind !== 'review' || selected.length === 0) return;
    setPhase({ kind: 'saving' });
    try {
      const r = await glossly.invoke('promises:save', { sessionId: s.sessionId, rows: selected.map((d) => toSave(d, people)) });
      setPhase({ kind: 'saved', ...r });
      panel.current?.focus();
    } catch {
      setPhase({ kind: 'review' });
    }
  };

  const switchToAllModels = async () => {
    const r = await glossly.invoke('settings:set', { key: 'privacy', value: 'all' });
    if (!r.error) await extract();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (phase.kind === 'saved' && e.key === 'Enter') {
      e.preventDefault();
      void glossly.invoke('bar:close', { sessionId: s.sessionId });
      return;
    }
    if (phase.kind !== 'review') return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      void save();
    } else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setHl((h) => (h + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (!typing && e.key === ' ' && rows[hl]) {
      e.preventDefault();
      patch(hl, { selected: !rows[hl]!.selected });
    }
  };

  return (
    <div className="panel promises" tabIndex={-1} ref={panel} onKeyDown={onKeyDown}>
      {phase.kind === 'loading' && <p className="thinking">Finding promises…</p>}

      {phase.kind === 'error' && (
        <div className="answer-error">
          <span className="error">{phase.result.message}</span>
          {phase.result.code === 'no_model' && <button onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>Add a key</button>}
          {phase.result.code === 'local_only' && (
            <>
              <button onClick={() => void switchToAllModels()}>Use all models and try again</button>
              <button onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>Set up a local model</button>
            </>
          )}
          {phase.result.code !== 'no_model' && phase.result.code !== 'local_only' && (
            <button onClick={() => void extract()}>
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
              Try again
            </button>
          )}
        </div>
      )}

      {(phase.kind === 'review' || phase.kind === 'saving') && (
        <>
          {meta?.byRules && (
            <div className="inline-note">
              <Info size={14} strokeWidth={1.75} aria-hidden />
              <span>
                {meta.byRules === 'local_only' ? 'Local only is on with no local model' : 'No model is set up'}, so these were found by simple patterns. Check
                each one.
              </span>
              <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>
                {meta.byRules === 'local_only' ? 'Set up a local model' : 'Add a key'}
              </button>
            </div>
          )}
          {meta && !meta.identitySet && (
            <div className="inline-note">
              <Info size={14} strokeWidth={1.75} aria-hidden />
              <span>Add your name so Glossly knows which promises are yours.</span>
              <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'profile' })}>
                Add your name
              </button>
            </div>
          )}
          {rows.length === 0 ? (
            <p className="muted">No promises or requests in this selection.</p>
          ) : (
            <>
              <h2>
                {meta?.authorIsMe ? 'From your message' : meta?.author ? `From ${meta.author}'s message` : 'Found in the selection'}
              </h2>
              <ul className="promise-list">
                {rows.map((d, i) => (
                  <Row key={d.key} d={d} highlight={s.keyboard && i === hl} onChange={(p) => patch(i, p)} onFocusRow={() => setHl(i)} />
                ))}
              </ul>
              <NewPeople rows={rows} people={people} onChange={(key, d) => setPeople((m) => ({ ...m, [key]: d }))} />
            </>
          )}
        </>
      )}

      {phase.kind === 'saved' && (
        <h2 className="saved-line">
          <Check size={17} strokeWidth={2} aria-hidden />
          <span>
            Saved {phase.saved} {phase.saved === 1 ? 'commitment' : 'commitments'}
            {phase.created > 0 && <span className="muted"> · added {phase.created === 1 ? '1 person' : `${phase.created} people`}</span>}
          </span>
        </h2>
      )}

      <div className="panel-foot">
        {phase.kind === 'saved' && (
          <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'people' })}>
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
            Open People
          </button>
        )}
        <span className="spacer" />
        {(phase.kind === 'review' || phase.kind === 'saving') && rows.length > 0 && (
          <button className="primary" disabled={selected.length === 0 || phase.kind === 'saving'} onClick={() => void save()}>
            {phase.kind === 'saving' ? 'Saving…' : `Save ${selected.length}`}
          </button>
        )}
        {s.keyboard && (
          <span>
            {phase.kind === 'saved' ? (
              <>
                <kbd>Enter</kbd> done · <kbd>Esc</kbd> back
              </>
            ) : rows.length > 0 && phase.kind !== 'error' && phase.kind !== 'loading' ? (
              <>
                <kbd>↑↓</kbd> move · <kbd>Space</kbd> keep or skip · <kbd>Enter</kbd> save
              </>
            ) : (
              <>
                <kbd>Esc</kbd> back
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
