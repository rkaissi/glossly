import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { GlosslyBridge, PushChannel } from '@glossly/core/api';

const PUSH: readonly PushChannel[] = [
  'overlay:state',
  'ask:chunk',
  'ask:done',
  'ask:error',
  'reply:chunk',
  'reply:done',
  'reply:error',
  'embed:progress',
  'settings:changed',
  'people:changed',
];

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
