import { writeFileSync } from 'node:fs';
import { app, clipboard, ClipboardItem, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  linkNamedPeople,
  namedPeople,
  REPLY_CHANNELS,
  REPLY_REDO_ASKS,
  WRITE_ASKS,
  STYLE_DIMENSIONS,
  channelWords,
  WROTE_OWN,
  aliasKindOf,
  allPreferences,
  asRelationship,
  cleanText,
  preferenceLabel,
  preferenceScope,
  type ReplyChannel,
  type ReplyPick,
  type ReplyRedo,
  type ReplyRedoAsk,
  type StylePole,
  type WriteAsk,
  type WriteStartArgs,
  type ContextUsed,
  type StyleDimension,
  type StyleView,
  type ActionId,
  type AliasKind,
  type CommitmentStatus,
  type TaskChange,
  type EventPatch,
  type EventSaveRow,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type PersonCard,
  type PromiseSaveRow,
  type SetSettingResult,
  type SettingsKey,
  ApiStyleSchema,
  ModelRefSchema,
  RoleNameSchema,
  type ApiStyle,
} from '@glossly/core';
import type { Capture } from './capture';
import type { HotkeyManager, SaveHotkey } from './hotkey';
import { logger } from './log';
import type { Overlay } from './overlay';
import type { Services } from './services';
import type { SettingsWindow } from './settings-window';
import type { Updater } from './updater';

const log = logger('ipc');

const ACTIONS: readonly ActionId[] = ['ask', 'save', 'reply', 'who', 'promises', 'visualize', 'search', 'recall', 'write'];
const TABS = ['tasks', 'calendar', 'people', 'saved', 'profile', 'models', 'privacy', 'general', 'metrics'] as const;
const ALIAS_KINDS: readonly AliasKind[] = ['email', 'handle', 'name'];
const STATUSES: readonly CommitmentStatus[] = ['open', 'done', 'dropped'];
const CHANGES: readonly TaskChange[] = ['new', 'same', 'done', 'moved'];
/** A due date as tasks store it: a day, or a timestamp with an offset. */
const DUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/;
const MAX_CLIPBOARD = 1_000_000;

export interface IpcDeps {
  services: Services;
  overlay: Overlay;
  capture: Capture;
  settingsWindow: SettingsWindow;
  hotkey: HotkeyManager;
  saveHotkey: SaveHotkey;
  /** Registers or unregisters the save hotkey to match the settings; queues a notice if it can't. */
  syncSaveHotkey: () => string | null;
  /** Pushes the settings view to every window. */
  broadcastSettings: () => void;
  /** Tells every window that people or commitments changed. */
  broadcastPeople: () => void;
  updater: Updater;
}

const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid argument');
  return v;
};
const str = (v: unknown, max = 10_000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument');
  return v;
};
const optStr = (v: unknown, max = 10_000): string | undefined => (v === undefined || v === null || v === '' ? undefined : str(v, max));
/** A list of at most `maxItems` strings of at most `max` characters each. */
const strList = (v: unknown, maxItems: number, max: number): string[] => {
  if (!Array.isArray(v) || v.length > maxItems) throw new Error('Invalid argument');
  return v.map((x) => str(x, max));
};
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) throw new Error('Invalid argument');
  return v as Record<string, unknown>;
};
/** Reply's pick: up to 3 drafts (text plus the model's tags) and the chosen index. Missing is fine (nothing is learned). */
const replyPick = (v: unknown): ReplyPick | undefined => {
  if (v === undefined || v === null) return undefined;
  const p = obj(v);
  if (!Array.isArray(p.drafts) || p.drafts.length === 0 || p.drafts.length > 3) throw new Error('Invalid argument');
  const drafts = p.drafts.map((raw) => {
    const d = obj(raw);
    return { text: str(d.text, 10_000), kind: optStr(d.kind, 30) ?? null, tone: optStr(d.tone, 30) ?? null };
  });
  const chosen = num(p.chosen);
  // WROTE_OWN (-1): the user wrote their own reply instead of taking a draft.
  if (!Number.isInteger(chosen) || chosen < WROTE_OWN || chosen >= drafts.length) throw new Error('Invalid argument');
  return { drafts, chosen };
};
/** "None of these": the drafts passed on, the asks from the panel's list, and what the user typed. */
const replyRedo = (v: unknown): ReplyRedo | undefined => {
  if (v === undefined || v === null) return undefined;
  const r = obj(v);
  if (!Array.isArray(r.passedOn) || r.passedOn.length > 3 || !Array.isArray(r.asks) || r.asks.length > REPLY_REDO_ASKS.length) throw new Error('Invalid argument');
  const passedOn = r.passedOn.map((raw) => {
    const d = obj(raw);
    return { intent: str(d.intent ?? '', 100), text: str(d.text, 10_000) };
  });
  const asks = r.asks.map((a) => {
    if (!(REPLY_REDO_ASKS as readonly unknown[]).includes(a)) throw new Error('Invalid argument');
    return a as ReplyRedoAsk;
  });
  return { passedOn, asks: [...new Set(asks)], note: optStr(r.note, 500) ?? null };
};
/** The kinds of saved data a prompt can draw on (decision 77). */
const CONTEXT_KINDS = ['note', 'person', 'task', 'event'] as const satisfies readonly ContextUsed['kind'][];
/** Write here's change: the text written before, the chips picked, and what the user typed. */
const writeChange = (v: unknown): WriteStartArgs['change'] => {
  if (v === undefined || v === null) return undefined;
  const r = obj(v);
  if (!Array.isArray(r.asks) || r.asks.length > WRITE_ASKS.length) throw new Error('Invalid argument');
  const asks = r.asks.map((a) => {
    if (!(WRITE_ASKS as readonly unknown[]).includes(a)) throw new Error('Invalid argument');
    return a as WriteAsk;
  });
  return { previous: str(r.previous, 20_000), asks: [...new Set(asks)], note: optStr(r.note, 500) };
};

export function registerIpc(deps: IpcDeps): void {
  const { services, overlay, capture, settingsWindow, hotkey, saveHotkey, syncSaveHotkey, broadcastSettings, broadcastPeople, updater } = deps;
  const people = services.people;

  const trusted = (e: IpcMainInvokeEvent) => overlay.isOwnWindow(e.sender.id) || settingsWindow.isOwnWindow(e.sender.id);

  function handle<C extends InvokeChannel>(
    channel: C,
    fn: (args: InvokeArgs<C>, e: IpcMainInvokeEvent) => InvokeResult<C> | Promise<InvokeResult<C>>,
  ): void {
    ipcMain.handle(channel, async (e, args: InvokeArgs<C>) => {
      if (!trusted(e)) throw new Error('Untrusted sender');
      try {
        return await fn(args, e);
      } catch (err) {
        log.warn('handler failed', { channel, name: (err as Error).name });
        throw err;
      }
    });
  }

  // ---- overlay ----
  handle('overlay:get', () => capture.state);
  handle('overlay:resize', (a) => overlay.resize(num(a.sessionId), num(a.w), num(a.h), a.popover === true));
  handle('bar:expand', (a) => capture.expand(num(a.sessionId)));
  handle('bar:run', (a) => {
    const o = obj(a);
    const sessionId = num(o.sessionId);
    if ('slot' in o) {
      const slot = num(o.slot);
      if (slot !== 1 && slot !== 2 && slot !== 3 && slot !== 4) throw new Error('Invalid slot');
      return capture.run(sessionId, { slot });
    }
    const action = str(o.action, 20) as ActionId;
    if (!ACTIONS.includes(action)) throw new Error('Invalid action');
    return capture.run(sessionId, { action });
  });
  handle('bar:dont-show-here', (a) => {
    const r = capture.dontShowHere(num(a.sessionId));
    if (r) broadcastSettings();
    return r;
  });
  handle('bar:show-here', (a) => {
    const r = capture.showHere(num(a.sessionId));
    if (r) broadcastSettings();
    return r;
  });
  handle('bar:back', (a) => capture.back(num(a.sessionId)));
  handle('bar:close', (a) => {
    if (num(a.sessionId) === capture.state.sessionId) capture.close('user');
  });

  // ---- Ask and Save ----
  handle('ask:start', (a, e) => capture.startAsk(num(a.sessionId), str(a.question ?? '', 2000), e.sender));
  handle('ask:cancel', (a) => capture.cancelAsk(str(a.requestId, 100)));
  handle('save:save', (a) => capture.save(num(a.sessionId), str(a.collection, 100), a.why === undefined ? undefined : str(a.why, 2000)));
  handle('save:setWhy', (a) => services.save.setWhy(str(a.itemId, 100), str(a.why, 2000)));
  handle('save:undo', (a) => ({ undone: services.save.undo(str(a.itemId, 100)) }));
  handle('saved:undo', (a) => capture.undoSaved(num(a.sessionId)));
  handle('clipboard:write', (a) => clipboard.writeText(str(a.text, MAX_CLIPBOARD)));
  handle('clipboard:image', async (a) => {
    const prefix = 'data:image/png;base64,';
    const url = str(a.dataUrl, 20_000_000);
    if (!url.startsWith(prefix)) throw new Error('Invalid image');
    const png = Buffer.from(url.slice(prefix.length), 'base64');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  });

  // ---- Visualize ----
  handle('visualize:run', (a) => capture.runVisualize(num(a.sessionId)));
  handle('visualize:save', (a) => capture.saveVisualize(num(a.sessionId)));

  // ---- Recall and search ----
  handle('recall:get', (a) => capture.recallHits(num(a.sessionId)));
  handle('recall:dismiss', (a) => capture.dismissRecall(num(a.sessionId), str(a.itemId, 100)));
  handle('recall:ask', (a) => capture.askAboutRecall(num(a.sessionId)));
  handle('ask:action-accept', (a) => capture.acceptAskAction(num(a.sessionId), str(a.id, 100)));
  handle('ask:action-undo', (a) => capture.undoAskAction(num(a.sessionId), str(a.id, 100)));
  handle('context:dismiss', (a) => {
    const kind = CONTEXT_KINDS.find((k) => k === a.kind);
    if (kind) capture.dismissContext(num(a.sessionId), kind, str(a.id, 100));
  });
  handle('search:query', (a) => capture.search(str(a.query ?? '', 500)));
  handle('items:copy', (a) => {
    const item = services.store.getItem(str(a.itemId, 100));
    if (!item) throw new Error('That item no longer exists.');
    clipboard.writeText(cleanText(item.text));
  });
  handle('items:insert', (a) => capture.insertItem(num(a.sessionId), str(a.itemId, 100)));
  handle('library:query', (a) => {
    const limit = num(a.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid argument');
    return capture.library({ query: str(a.query ?? '', 500), collection: optStr(a.collection, 100) ?? null, limit });
  });
  handle('items:delete', (a) => {
    const deleted = services.save.remove(str(a.itemId, 100));
    if (deleted) log.info('item deleted');
    return { deleted };
  });
  handle('items:edit', (a) => {
    const itemId = str(a.itemId, 100);
    const text = str(a.text, 2000);
    const edited = services.save.editMemory(itemId, text);
    if (edited) linkNamedPeople(services.store, services.people, itemId, text);
    return { edited };
  });
  handle('items:move', (a) => {
    const name = str(a.collection, 100).trim();
    if (!name) throw new Error('Pick a collection.');
    return { collection: services.save.move(str(a.itemId, 100), name) };
  });

  // ---- Reply ----
  handle('reply:start', (a, e) => capture.startReply(num(a.sessionId), e.sender, replyRedo(a.redo)));
  handle('reply:cancel', (a) => capture.cancelReply(str(a.requestId, 100)));
  handle('reply:insert', async (a) => {
    if (typeof a.edited !== 'boolean') throw new Error('Invalid argument');
    const r = await capture.insertReply(num(a.sessionId), str(a.text, 10_000), a.edited, optStr(a.personId, 100), replyPick(a.pick));
    broadcastPeople();
    return r;
  });
  handle('reply:copied', (a) =>
    capture.replyCopied(num(a.sessionId), a.text === undefined ? undefined : str(a.text, 10_000), replyPick(a.pick), optStr(a.personId, 100)),
  );

  // ---- Write here (nothing selected, decision 81) ----
  handle('write:open', (a) => capture.openWrite(num(a.sessionId)));
  const contextKinds = (v: unknown): ContextUsed['kind'][] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.length > CONTEXT_KINDS.length || !v.every((k) => (CONTEXT_KINDS as readonly unknown[]).includes(k))) throw new Error('Invalid argument');
    return [...new Set(v as ContextUsed['kind'][])];
  };
  handle('write:start', (a, e) =>
    capture.startWrite(num(a.sessionId), e.sender, { request: optStr(a.request, 500), change: writeChange(a.change), suggested: a.suggested === true, include: contextKinds(a.include) }),
  );
  handle('write:cancel', (a) => capture.cancelWrite(str(a.requestId, 100)));
  handle('write:insert', (a) => {
    if (typeof a.edited !== 'boolean' || (a.mode !== 'written' && a.mode !== 'snippets')) throw new Error('Invalid argument');
    return capture.insertWrite(num(a.sessionId), str(a.text, 20_000), a.mode, a.edited, optStr(a.original, 20_000));
  });

  // ---- Tasks (formerly What did I promise) ----
  handle('promises:extract', (a) => capture.extractPromises(num(a.sessionId)));
  handle('promises:save', (a) => {
    if (!Array.isArray(a.rows) || a.rows.length > 20) throw new Error('Invalid rows');
    const rows = a.rows.map((raw): PromiseSaveRow => {
      const r = obj(raw);
      const owner = str(r.owner, 5);
      if (owner !== 'me' && owner !== 'them') throw new Error('Invalid owner');
      const due = r.due_at === null ? null : str(r.due_at, 40);
      if (due !== null && !DUE.test(due)) throw new Error('Invalid date');
      const change = r.change === undefined ? 'new' : str(r.change, 10);
      if (!CHANGES.includes(change as TaskChange)) throw new Error('Invalid change');
      const existingId = change === 'new' ? undefined : str(r.existingId, 100);
      const p = r.person === null ? null : obj(r.person);
      const person: PromiseSaveRow['person'] =
        p === null
          ? null
          : p.kind === 'existing'
            ? { kind: 'existing', id: str(p.id, 100) }
            : p.kind === 'new'
              ? {
                  kind: 'new',
                  name: str(p.name, 100),
                  email: optStr(p.email, 200) ?? null,
                  handle: optStr(p.handle, 100) ?? null,
                  note: optStr(p.note, 2000) ?? null,
                  relationship: p.relationship == null ? null : asRelationship(p.relationship),
                }
              : null;
      return { change: change as TaskChange, existingId, owner, text: str(r.text, 500), due_at: due, person };
    });
    if (a.events !== undefined && (!Array.isArray(a.events) || a.events.length > 5)) throw new Error('Invalid events');
    const events = (a.events ?? []).map((raw): EventSaveRow => {
      const e = obj(raw);
      const starts_at = str(e.starts_at, 40);
      if (!DUE.test(starts_at)) throw new Error('Invalid date');
      const ends_at = e.ends_at === null || e.ends_at === undefined ? null : str(e.ends_at, 40);
      if (ends_at && !DUE.test(ends_at)) throw new Error('Invalid date');
      const attendees = Array.isArray(e.attendees) ? e.attendees.slice(0, 20).map((x) => str(x, 100)) : [];
      const personIds = Array.isArray(e.personIds) ? e.personIds.slice(0, 20).map((x) => str(x, 100)) : [];
      return { title: str(e.title, 200), starts_at, ends_at, all_day: e.all_day === true, location: optStr(e.location, 300) ?? null, attendees, personIds };
    });
    const r = capture.savePromises(num(a.sessionId), rows, events);
    broadcastPeople();
    return r;
  });

  // ---- people ----
  handle('who:get', (a) => capture.who(num(a.sessionId)));
  /** Runs a change, tells every window, and returns the person's overlay card. */
  const changed = (personId: string): PersonCard => {
    broadcastPeople();
    const card = people.card(personId);
    if (!card) throw new Error('That person no longer exists.');
    return card;
  };
  handle('people:list', (a) => people.list(optStr(a?.query, 200) ?? ''));
  handle('people:card', (a) => people.card(str(a.personId, 100), { interactions: 20, items: 20 }));
  handle('people:create', (a) => {
    const aliases = [
      ...(optStr(a.email, 200) ? [{ kind: 'email' as const, value: str(a.email, 200) }] : []),
      ...(optStr(a.handle, 100) ? [{ kind: 'handle' as const, value: str(a.handle, 100) }] : []),
    ];
    const p = people.create({ name: str(a.name, 200), note: optStr(a.note, 2000) ?? null, relationship: asRelationship(a.relationship), aliases });
    log.info('person created', { aliases: aliases.length });
    return changed(p.id);
  });
  handle('people:confirm-same', (a) => {
    const id = str(a.personId, 100);
    for (const [kind, v] of [['name', a.name], ['email', a.email], ['handle', a.handle]] as const) {
      const value = optStr(v, 200);
      // Quietly skips an alias someone else already has; the user can sort that out in the record.
      if (value) {
        try {
          people.addAlias(id, kind, value);
        } catch (e) {
          if ((e as Error).name !== 'AliasTakenError') throw e;
        }
      }
    }
    return changed(id);
  });
  handle('people:update', (a) => {
    const id = str(a.personId, 100);
    people.update(id, {
      ...(a.name !== undefined && { name: str(a.name, 200) }),
      ...(a.note !== undefined && { note: a.note === null ? null : str(a.note, 2000) }),
      ...(a.relationship !== undefined && { relationship: asRelationship(a.relationship) }),
    });
    return changed(id);
  });
  handle('people:alias-add', (a) => {
    const id = str(a.personId, 100);
    const value = str(a.value, 200);
    const kind = a.kind ? (str(a.kind, 10) as AliasKind) : aliasKindOf(value);
    if (!ALIAS_KINDS.includes(kind)) throw new Error('Invalid alias kind');
    people.addAlias(id, kind, value);
    return changed(id);
  });
  handle('people:alias-remove', (a) => {
    const id = str(a.personId, 100);
    const kind = str(a.kind, 10) as AliasKind;
    if (!ALIAS_KINDS.includes(kind)) throw new Error('Invalid alias kind');
    people.removeAlias(id, kind, str(a.value, 200));
    return changed(id);
  });
  handle('people:merge', (a) => {
    const keep = str(a.keepId, 100);
    people.merge(keep, str(a.dropId, 100));
    log.info('people merged');
    return changed(keep);
  });
  handle('people:delete', (a) => {
    people.delete(str(a.personId, 100));
    log.info('person deleted');
    broadcastPeople();
  });
  handle('commitments:list', (a) => {
    const status = optStr(a?.status, 10) as CommitmentStatus | undefined;
    if (status && !STATUSES.includes(status)) throw new Error('Invalid status');
    const personId = optStr(a?.personId, 100);
    return people.commitments({ ...(status && { status }), ...(personId && { personId }) });
  });
  handle('commitments:update', (a) => {
    const due = a.due_at === undefined ? undefined : a.due_at === null ? null : str(a.due_at, 40);
    if (due && !DUE.test(due)) throw new Error('Invalid date');
    people.updateCommitment(str(a.id, 100), { ...(a.text !== undefined && { text: str(a.text, 300) }), ...(due !== undefined && { due_at: due }) });
    broadcastPeople();
  });
  handle('calendar:list', (a) => {
    const day = (v: unknown) => {
      const s = optStr(v, 10);
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Invalid date');
      return s;
    };
    const from = day(a?.from);
    const to = day(a?.to);
    const personId = optStr(a?.personId, 100);
    return services.calendar.list({ ...(from && { from }), ...(to && { to }), ...(personId && { personId }) });
  });
  handle('calendar:update', (a) => {
    const p = obj(a.patch);
    const patch: EventPatch = {};
    if (p.title !== undefined) patch.title = str(p.title, 200);
    if (p.starts_at !== undefined) {
      patch.starts_at = str(p.starts_at, 40);
      if (!DUE.test(patch.starts_at)) throw new Error('Invalid date');
    }
    if (p.ends_at !== undefined) {
      patch.ends_at = p.ends_at === null ? null : str(p.ends_at, 40);
      if (patch.ends_at && !DUE.test(patch.ends_at)) throw new Error('Invalid date');
    }
    if (p.all_day !== undefined) patch.all_day = p.all_day === true;
    if (p.location !== undefined) patch.location = p.location === null ? null : str(p.location, 300);
    if (p.personIds !== undefined) patch.personIds = strList(p.personIds, 50, 100);
    services.calendar.update(str(a.id, 100), patch);
    broadcastPeople();
  });
  handle('calendar:add', (a) => {
    const starts = str(a.starts_at, 40);
    const ends = a.ends_at === null || a.ends_at === undefined ? null : str(a.ends_at, 40);
    if (!DUE.test(starts) || (ends && !DUE.test(ends))) throw new Error('Invalid date');
    const e = services.calendar.add(
      {
        title: str(a.title, 200),
        starts_at: starts,
        ends_at: ends,
        all_day: a.all_day === true,
        location: a.location === null || a.location === undefined ? null : str(a.location, 300),
        attendees: strList(a.attendees ?? [], 50, 100),
        personIds: strList(a.personIds ?? [], 50, 100),
      },
      null,
    );
    log.info('event added', { allDay: e.all_day, people: e.people.length });
    broadcastPeople();
    return e;
  });
  handle('calendar:delete', (a) => {
    services.calendar.delete(str(a.id, 100));
    broadcastPeople();
  });
  handle('commitments:add', (a) => {
    const due = a.due_at === null ? null : str(a.due_at, 40);
    if (due && !DUE.test(due)) throw new Error('Invalid date');
    // Quick add with the person filter set: the user owes that person (Step 21). An unknown id is ignored.
    // Without the filter, a title naming one saved person by a full or saved name ("Send Casey
    // Lin the notes") is owed to them; a first name alone, or two people, links no one.
    const text = str(a.text, 300);
    const named = namedPeople(people, [text]);
    const personId = typeof a.person_id === 'string' && people.get(a.person_id) ? a.person_id : named.length === 1 ? named[0]! : null;
    people.addCommitment({ person_id: personId, owner: 'me', text, due_at: due, source_interaction_id: null });
    broadcastPeople();
  });
  handle('commitments:delete', (a) => {
    people.deleteCommitment(str(a.id, 100));
    broadcastPeople();
  });
  handle('voice:list', () => people.voiceSamples());
  handle('voice:add', (a) => {
    if (people.voiceSamples().filter((v) => v.origin === 'pasted').length >= 5) throw new Error('Keep at most 5 samples; remove one first.');
    people.addVoice(str(a.text, 2000), 'pasted');
    return people.voiceSamples();
  });
  handle('voice:remove', (a) => {
    people.deleteVoice(str(a.id, 100));
    return people.voiceSamples();
  });
  handle('voice:label', (a) => {
    const channel = a.channel === null ? null : str(a.channel, 20);
    if (channel !== null && !(REPLY_CHANNELS as readonly string[]).includes(channel)) throw new Error('Unknown platform.');
    people.setVoiceChannel(str(a.id, 100), channel as ReplyChannel | null);
    return people.voiceSamples();
  });

  // ---- What Reply learned (Profile > How you write) ----
  const styleView = (): StyleView => ({
    learning: services.settings.replyLearning,
    preferences: allPreferences(people.styleSignals()).map((p) => {
      const name = p.personId ? (people.get(p.personId)?.name ?? null) : null;
      return { ...p, label: preferenceLabel(p), where: preferenceScope(p, name) };
    }),
    notes: people.styleNotes().map((n) => ({ ...n, where: n.channel ? channelWords(n.channel) : null })),
    dropped: people
      .allDroppedKinds()
      .flatMap((d) => (CONTEXT_KINDS as readonly string[]).includes(d.kind) ? [{ channel: d.channel, kind: d.kind as ContextUsed['kind'], where: channelWords(d.channel) }] : []),
  });
  const channelArg = (v: unknown): ReplyChannel => {
    const c = str(v, 20);
    if (!(REPLY_CHANNELS as readonly string[]).includes(c)) throw new Error('Unknown platform.');
    return c as ReplyChannel;
  };
  handle('style:get', () => styleView());
  handle('style:forget', (a) => {
    const dimension = str(a.dimension, 20) as StyleDimension;
    if (!(STYLE_DIMENSIONS as readonly string[]).includes(dimension)) throw new Error('Invalid argument');
    const channel = a.channel === null ? null : channelArg(a.channel);
    const pole = a.pole === undefined || a.pole === null ? undefined : (str(a.pole, 20) as StylePole);
    people.forgetStyle(dimension, { channel, personId: a.personId === null ? null : str(a.personId, 100), relationship: asRelationship(a.relationship), pole });
    return styleView();
  });
  handle('style:forget-dropped', (a) => {
    const kind = CONTEXT_KINDS.find((k) => k === a.kind);
    if (!kind) throw new Error('Invalid argument');
    people.forgetDropped(channelArg(a.channel), kind);
    return styleView();
  });
  handle('style:note-remove', (a) => {
    people.removeStyleNote(str(a.id, 100));
    return styleView();
  });
  handle('commitments:set-status', (a) => {
    const status = str(a.status, 10) as CommitmentStatus;
    if (!STATUSES.includes(status)) throw new Error('Invalid status');
    people.setCommitmentStatus(str(a.id, 100), status);
    broadcastPeople();
  });

  // ---- settings ----
  handle('settings:get', () => services.view());
  handle('settings:set', (a): SetSettingResult => {
    const key = str(a.key, 50) as SettingsKey;
    if (key === 'roles') throw new Error('Use roles:set');
    if (key === 'local') throw new Error('Use local:connect, local:remove, or local:model');
    if (key === 'providers') throw new Error('Use providers:add or providers:remove');
    if (key === 'hotkey') {
      const value = str(a.value, 100);
      if (services.settings.saveMode === 'hotkey' && value === services.settings.saveHotkey) {
        return { settings: services.settings, error: 'That is already the save hotkey. Pick a different shortcut.' };
      }
      const err = hotkey.change(value);
      if (err) return { settings: services.settings, error: err };
      // The start's "is taken" notice is stale once a hotkey works.
      if (services.settings.pendingNotice?.startsWith('The hotkey ')) services.setSetting('pendingNotice', null);
    }
    if (key === 'saveHotkey' && services.settings.saveMode === 'hotkey') {
      const err = saveHotkey.change(str(a.value, 100), services.settings.hotkey);
      if (err) return { settings: services.settings, error: err };
    }
    try {
      services.setSetting(key, a.value);
    } catch {
      return { settings: services.settings, error: 'That value is not valid.' };
    }
    const error = key === 'saveMode' ? syncSaveHotkey() : null;
    broadcastSettings();
    return { settings: services.settings, ...(error && { error }) };
  });
  handle('providers:add', async (a) => {
    const api = optStr(a.api, 20);
    if (api !== undefined && !ApiStyleSchema.safeParse(api).success) throw new Error('Unknown way of talking');
    const r = await services.addProvider({
      preset: str(a.preset, 40),
      id: optStr(a.id, 40),
      key: optStr(a.key, 1000),
      label: optStr(a.label, 60),
      baseUrl: optStr(a.baseUrl, 300),
      api: api as ApiStyle | undefined,
    });
    broadcastSettings();
    return r;
  });
  handle('providers:test', async (a) => {
    const r = await services.testProvider(str(a.id, 40));
    broadcastSettings();
    return r;
  });
  handle('providers:remove', (a) => {
    services.removeProvider(str(a.id, 40));
    broadcastSettings();
  });
  handle('local:detect', () => services.detectLocal());
  handle('local:connect', async (a) => {
    const r = await services.connectLocal(str(a.baseUrl, 300));
    broadcastSettings();
    return r;
  });
  handle('local:test', async () => {
    const r = await services.testLocal();
    broadcastSettings();
    return r;
  });
  handle('local:remove', () => {
    services.removeLocal();
    broadcastSettings();
  });
  handle('local:model', (a) => {
    services.setLocalModel(str(a.model, 200));
    broadcastSettings();
  });
  handle('models:refresh', async () => {
    const r = await services.refreshModels();
    broadcastSettings();
    return r;
  });
  handle('roles:restore', (a) => {
    const moves = (Array.isArray(a.moves) ? a.moves.slice(0, 3) : []).map((m: unknown) => {
      const o = obj(m);
      const role = RoleNameSchema.parse(o.role);
      return { role, from: ModelRefSchema.parse(o.from), fromFallback: o.fromFallback == null ? null : ModelRefSchema.parse(o.fromFallback), to: null };
    });
    const roles = services.restoreRoles(moves);
    broadcastSettings();
    return roles;
  });
  handle('roles:set', (a) => {
    const role = str(a.role, 20);
    if (role !== 'fast' && role !== 'chat' && role !== 'decision') throw new Error('Invalid role');
    const model = a.model === null ? null : str(a.model, 200);
    const fallback = a.fallback === null ? null : str(a.fallback, 200);
    const roles = services.setRole({ role, model, fallback });
    broadcastSettings();
    return roles;
  });

  // ---- data ----
  handle('data:export', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const parent = settingsWindow.window;
    const opts = { defaultPath: `glossly-export-${date}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, JSON.stringify(services.store.exportAll(), null, 2));
    log.info('exported');
    return { path: r.filePath };
  });
  handle('entities:backfill', async () => {
    const r = await services.save.backfillEntities();
    log.info('entities backfill', { done: r.done, left: r.left, failed: Boolean(r.error) });
    broadcastSettings();
    if (r.done) broadcastPeople();
    return r;
  });
  handle('data:delete-all', async () => {
    capture.close('delete_all');
    capture.clearCaches();
    await services.deleteAll();
    log.info('all data deleted');
    broadcastSettings();
    broadcastPeople();
  });
  handle('settings:reset', () => {
    capture.close('reset_settings');
    services.resetSettings();
    if (hotkey.change(services.settings.hotkey)) log.warn('default hotkey unavailable after reset');
    syncSaveHotkey();
    log.info('settings reset');
    broadcastSettings();
  });
  handle('metrics:summary', (a) => services.metrics.summary(Math.min(Math.max(Math.trunc(num(a.days)), 1), 90)));
  handle('embed:status', () => services.embed.getStatus());
  handle('embed:download', () => services.embed.start());
  handle('settings:open', (a, e) => {
    // From the overlay (its menu, or "Add a key"): the bar's job is done; close it so it
    // doesn't sit on top of the settings window.
    if (overlay.isOwnWindow(e.sender.id)) capture.close('settings');
    const tab = a?.tab && (TABS as readonly string[]).includes(a.tab) ? a.tab : undefined;
    const personId = tab === 'people' ? optStr(a?.personId, 100) : undefined;
    settingsWindow.open(personId ? `people/${encodeURIComponent(personId)}` : tab);
  });
  handle('setup:try-it', (a, e) => {
    if (!settingsWindow.isOwnWindow(e.sender.id)) throw new Error('Settings window only');
    settingsWindow.setTryIt(obj(a).active === true);
  });

  // ---- updates (decision 70) ----
  handle('updates:get', () => updater.view);
  handle('updates:check', () => updater.check());
  handle('updates:download', () => updater.download());
  handle('updates:install', () => {
    if (updater.requestRestart()) app.quit();
  });
}
