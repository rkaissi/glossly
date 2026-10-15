// Ask's tools besides `remember` (decision 78): add a task, add an event, add to a saved person's
// note or set their relationship, and add a fact about the user. Each takes `asked`: when the
// person asked for it, it's done at once and said in the answer; when Ask only noticed it, a
// task or event is offered as a one-click chip and an edit is done quietly, both with Undo in the
// panel. This file turns the model's input into rows; the shell applies, offers, and undoes them.
import { tool } from 'ai';
import { z } from 'zod';
import { resolveEventTime } from '../calendar/when';
import { dayLabel, eventLabel } from '../context/prompt';
import { resolveDue } from '../people/dates';
import { RELATIONSHIPS, type Relationship } from '../people/relationship';
import type { CommitmentOwner } from '../people/types';

/** What a tool did, for the answer (`say`, only when asked) and the panel row. */
export type ToolOutcome = { ok: true; label: string } | { ok: false; reason: string };

export interface TaskDraft {
  text: string;
  owner: CommitmentOwner;
  /** A saved person, matched exactly; null for the user's own task or someone not saved. */
  person_id: string | null;
  person_name: string | null;
  due_at: string | null;
}

export interface EventDraft {
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location: string | null;
  attendees: string[];
  /** Attendees who are saved people, matched exactly. */
  personIds: string[];
}

export interface PersonEdit {
  personId: string;
  name: string;
  /** A line to add to their note. */
  addNote: string | null;
  relationship: Relationship | null;
}

export interface AskToolDeps {
  /** Saved people by exact name or saved name ("Jordan Hale"), else null. Never creates one. */
  personByName: (name: string) => { id: string; name: string } | null;
  addTask: (t: TaskDraft, asked: boolean, label: string) => ToolOutcome | Promise<ToolOutcome>;
  addEvent: (e: EventDraft, asked: boolean, label: string) => ToolOutcome | Promise<ToolOutcome>;
  editPerson: (p: PersonEdit, asked: boolean, label: string) => ToolOutcome | Promise<ToolOutcome>;
  addAboutMe: (fact: string, asked: boolean) => ToolOutcome | Promise<ToolOutcome>;
  now?: () => Date;
}

const clean = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const said = (asked: boolean, o: ToolOutcome, done: (label: string) => string) => ({ say: asked ? (o.ok ? done(o.label) : o.reason) : '' });

/** The model's task as a row: the due phrase read by `resolveDue`, the person matched exactly. */
export function taskDraft(input: { text: string; due?: string | null; person?: string | null; owner: CommitmentOwner }, deps: Pick<AskToolDeps, 'personByName'>, now: Date): TaskDraft | null {
  const text = clean(input.text, 500);
  if (!text) return null;
  const name = clean(input.person, 100);
  const person = name ? deps.personByName(name) : null;
  return { text, owner: input.owner, person_id: person?.id ?? null, person_name: person?.name ?? (name || null), due_at: input.due ? resolveDue(input.due, now) : null };
}

/** "Send the deck to Jordan Hale, due tomorrow". */
export function taskDraftLabel(t: TaskDraft, now: Date): string {
  const due = t.due_at ? `, due ${dayLabel(new Date(t.due_at.length === 10 ? `${t.due_at}T12:00:00` : t.due_at), now)}` : '';
  return `${t.text}${due}`;
}

/** The model's event as a row, or null when its day can't be read. */
export function eventDraft(
  input: { title: string; when: string; end?: string | null; location?: string | null; attendees?: string[] },
  deps: Pick<AskToolDeps, 'personByName'>,
  now: Date,
): EventDraft | null {
  const title = clean(input.title, 200);
  const time = resolveEventTime({ when: clean(input.when, 100), ...(input.end && { end: clean(input.end, 50) }) }, now);
  if (!title || !time) return null;
  const attendees = (input.attendees ?? []).map((a) => clean(a, 100)).filter(Boolean).slice(0, 20);
  const personIds = [...new Set(attendees.map((a) => deps.personByName(a)?.id).filter((x): x is string => Boolean(x)))];
  return { title, ...time, location: clean(input.location, 200) || null, attendees, personIds };
}

/** "Lunch with Jordan, tomorrow, 1:00 PM to 2:00 PM". */
export function eventDraftLabel(e: EventDraft, now: Date): string {
  return `${e.title}, ${eventLabel(e, now).replace(/, in \d+ (minutes|hours?)$/, '')}`;
}

/** Ask's tools (decision 78), for the stream next to `remember`. Local models get none. */
export function askTools(deps: AskToolDeps) {
  const now = () => deps.now?.() ?? new Date();
  return {
    add_task: tool({
      description:
        'Add a task to the person\'s Tasks: something they promised, were asked to do, or want to do, or something someone owes them. Use asked=true only when they asked you to add it; otherwise it is offered to them, not added.',
      inputSchema: z.object({
        text: z.string().describe('The task as a short line, like "Send Jordan the deck".'),
        due: z.string().nullable().describe('The due day and time as written ("Friday", "tomorrow 3pm"), or null.'),
        person: z.string().nullable().describe('The other person\'s full name, or null for their own task.'),
        owner: z.enum(['me', 'them']).describe('"me" when the person asking does it, "them" when the other person owes it.'),
        asked: z.boolean().describe('True when they asked you to add it.'),
      }),
      execute: async (input) => {
        const t = taskDraft(input, deps, now());
        if (!t) return { say: input.asked ? 'There was no task to add.' : '' };
        const o = await deps.addTask(t, input.asked, taskDraftLabel(t, now()));
        return said(input.asked, o, (l) => `Added to your tasks: ${l}`);
      },
    }),
    add_event: tool({
      description:
        'Add an event to the person\'s Calendar: a meeting, call, appointment, or plan with a day. Use asked=true only when they asked you to add it; otherwise it is offered to them, not added.',
      inputSchema: z.object({
        title: z.string().describe('A short title, like "Lunch with Jordan Hale".'),
        when: z.string().describe('The day and start as written ("Thursday 1pm", "Oct 20", "1-2pm tomorrow").'),
        end: z.string().nullable().describe('The end time as written, or null.'),
        location: z.string().nullable(),
        attendees: z.array(z.string()).describe('Full names of the others attending.'),
        asked: z.boolean().describe('True when they asked you to add it.'),
      }),
      execute: async (input) => {
        const e = eventDraft(input, deps, now());
        if (!e) return { say: input.asked ? "I couldn't tell which day that is, so nothing was added." : '' };
        const o = await deps.addEvent(e, input.asked, eventDraftLabel(e, now()));
        return said(input.asked, o, (l) => `Added to your calendar: ${l}`);
      },
    }),
    update_person: tool({
      description:
        'Add to what the person knows about someone already in their saved people (by full name): a line for their note (their role, where they work, how they know them), or their relationship. Never for someone not saved.',
      inputSchema: z.object({
        name: z.string().describe('The saved person\'s full name.'),
        add_to_note: z.string().nullable().describe('One short line to add to their note, or null.'),
        relationship: z.enum(RELATIONSHIPS).nullable().describe('Their relationship to the person asking, when it is clear, or null.'),
        asked: z.boolean().describe('True when they asked you to.'),
      }),
      execute: async (input) => {
        const p = deps.personByName(clean(input.name, 100));
        if (!p) return { say: input.asked ? `${clean(input.name, 100) || 'That person'} isn't in your people yet, so nothing was changed.` : '' };
        const addNote = clean(input.add_to_note, 300) || null;
        if (!addNote && !input.relationship) return { say: input.asked ? 'There was nothing to change.' : '' };
        const what = [addNote && `"${addNote}"`, input.relationship && `relationship: ${input.relationship}`].filter(Boolean).join(', ');
        const o = await deps.editPerson({ personId: p.id, name: p.name, addNote, relationship: input.relationship }, input.asked, `${p.name}: ${what}`);
        return said(input.asked, o, (l) => `Updated ${l}`);
      },
    }),
    about_me: tool({
      description:
        'Remember a fact about the person asking themselves (their job, where they live, a lasting preference), shown on their Profile and given to you every time. Not for other people, passing details, or secrets.',
      inputSchema: z.object({
        fact: z.string().describe('One short fact in the third person, like "Works as a product designer at Acme".'),
        asked: z.boolean().describe('True when they asked you to remember it.'),
      }),
      execute: async (input) => {
        const fact = clean(input.fact, 300);
        if (!fact) return { say: '' };
        const o = await deps.addAboutMe(fact, input.asked);
        return said(input.asked, o, (l) => `Noted about you: ${l}`);
      },
    }),
  };
}

/** Adds a fact to the user's list unless it's already there (same words); null when it is. */
export function withAboutMe(list: { id: string; text: string; at: string }[], fact: string, id: string, at: string, max = 50): { id: string; text: string; at: string }[] | null {
  const key = fact.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (list.some((f) => f.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === key)) return null;
  return [...list, { id, text: fact, at }].slice(-max);
}
