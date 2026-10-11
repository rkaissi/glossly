import { useState, type KeyboardEvent } from 'react';
import { UserRoundPlus } from 'lucide-react';
import type { PersonCard, Relationship } from '@glossly/core/api';
import { draftToCreate, type PersonDraft } from './draft';
import { glossly } from '../bridge';
import { Select } from '../controls/Select';
import { useAction } from '../settings/useAction';
import { RELATIONSHIP_OPTIONS } from './relationship';

/** Name, email, handle, about, and relationship. `showName` false when the name is the row's heading. */
export function PersonFields({ value, onChange, showName = true }: { value: PersonDraft; onChange: (d: PersonDraft) => void; showName?: boolean }) {
  const set = (patch: Partial<PersonDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="form-grid">
      {showName && <input value={value.name} placeholder="Name" aria-label="Name" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />}
      <input value={value.email} placeholder="Email (optional)" aria-label="Email" spellCheck={false} onChange={(e) => set({ email: e.target.value })} />
      <input value={value.handle} placeholder="Handle (optional)" aria-label="Handle" spellCheck={false} onChange={(e) => set({ handle: e.target.value })} />
      <input className="wide" value={value.note} placeholder="About this person (optional)" aria-label="About" onChange={(e) => set({ note: e.target.value })} />
      <Select<Relationship>
        label="Relationship"
        value={value.relationship}
        onChange={(relationship) => set({ relationship })}
        options={RELATIONSHIP_OPTIONS.map(([v, text]) => ({ value: v, label: text }))}
      />
    </div>
  );
}

/** Add a person: the fields prefilled from what was found, then "Create person" (Enter) and, where it can be dismissed, Cancel (Esc). */
export function CreatePerson({ initial, title, onCreated, onCancel }: { initial: PersonDraft; title: string; onCreated: (card: PersonCard) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState(initial);
  const { busy, error, run } = useAction();
  const create = () =>
    void run(async () => {
      if (!draft.name.trim()) throw new Error('Type a name first.');
      onCreated(await glossly.invoke('people:create', draftToCreate(draft)));
    });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      e.stopPropagation();
      create();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="create-person" onKeyDown={onKeyDown}>
      <h2>{title}</h2>
      <PersonFields value={draft} onChange={setDraft} />
      <div className="row-tight">
        <button className="primary" disabled={busy || !draft.name.trim()} onClick={create}>
          <UserRoundPlus size={15} strokeWidth={1.75} aria-hidden />
          Create person
        </button>
        {onCancel && (
          <button className="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
