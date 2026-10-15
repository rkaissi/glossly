import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { GlosslyBridge, PushChannel } from '@glossly/core/api';

// Every push channel, as a record so a channel added to the API without being listed here fails typecheck.
const PUSH_CHANNELS: Record<PushChannel, true> = {
  'overlay:state': true,
  'ask:chunk': true,
  'ask:done': true,
  'ask:error': true,
  'ask:saved': true,
  'ask:context': true,
  'ask:action': true,
  'reply:chunk': true,
  'reply:done': true,
  'reply:error': true,
  'embed:progress': true,
  'settings:changed': true,
  'people:changed': true,
  'setup:tried': true,
  'updates:state': true,
};
const PUSH = Object.keys(PUSH_CHANNELS) as PushChannel[];

const bridge: GlosslyBridge = {
  invoke: ((channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as GlosslyBridge['invoke'],
  on(channel, listener) {
    if (!PUSH.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('glossly', bridge);
