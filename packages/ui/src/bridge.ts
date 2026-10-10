import type { GlosslyBridge } from '@glossly/core/api';

declare global {
  interface Window {
    glossly: GlosslyBridge;
  }
}

export const glossly: GlosslyBridge = window.glossly;
