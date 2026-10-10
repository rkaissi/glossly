import { globalShortcut } from 'electron';
import type { Settings } from '@glossly/core';
import { logger } from './log';

const log = logger('hotkey');

/** A global shortcut: the main hotkey, or the save hotkey. These are the only keyboard hooks Glossly installs. */
export class HotkeyManager {
  private current: string | null = null;

  constructor(
    private readonly onPress: () => void,
    private readonly name = 'hotkey',
  ) {}

  /** Registers the accelerator. Returns false if another app holds it. */
  register(accelerator: string): boolean {
    try {
      if (globalShortcut.register(accelerator, this.onPress)) {
        this.current = accelerator;
        log.info('registered', { name: this.name, accelerator });
        return true;
      }
    } catch {
      /* invalid accelerator */
    }
    log.warn('could not register', { name: this.name, accelerator });
    return false;
  }

  /** Switches to a new accelerator, keeping the old one if the new one fails. Returns an error message or null. */
  change(accelerator: string): string | null {
    if (accelerator === this.current) return null;
    const old = this.current;
    this.unregister();
    if (this.register(accelerator)) return null;
    if (old) this.register(old);
    return 'That hotkey is taken by another app or is not a valid shortcut. The old one is kept.';
  }

  unregister(): void {
    if (this.current) globalShortcut.unregister(this.current);
    this.current = null;
  }

  get accelerator(): string | null {
    return this.current;
  }

  dispose(): void {
    this.unregister();
  }
}

/** Tried in order when the default save hotkey is taken. */
const SAVE_FALLBACKS = ['Control+Alt+S', 'Control+Alt+Shift+S', 'Control+Shift+Alt+B'];
export const DEFAULT_SAVE_HOTKEY = SAVE_FALLBACKS[0]!;

export interface SaveHotkeySync {
  /** What is registered now, or null (another Save mode, or nothing could be registered). */
  accelerator: string | null;
  error?: string;
}

/**
 * The save hotkey (Save mode "Manual, plus a save hotkey", decision 15). Registered only in
 * that mode. The default falls back to the next free shortcut; one the user picked does not.
 */
export class SaveHotkey {
  private readonly mgr: HotkeyManager;

  constructor(onPress: () => void) {
    this.mgr = new HotkeyManager(onPress, 'save hotkey');
  }

  /** Registers or unregisters to match the settings. */
  sync(settings: Pick<Settings, 'saveMode' | 'saveHotkey' | 'hotkey'>): SaveHotkeySync {
    if (settings.saveMode !== 'hotkey') {
      this.mgr.unregister();
      return { accelerator: null };
    }
    if (this.mgr.accelerator === settings.saveHotkey) return { accelerator: settings.saveHotkey };
    this.mgr.unregister();
    const tries = settings.saveHotkey === DEFAULT_SAVE_HOTKEY ? SAVE_FALLBACKS : [settings.saveHotkey];
    for (const acc of tries) {
      if (acc === settings.hotkey) continue;
      if (this.mgr.register(acc)) return { accelerator: acc };
    }
    return { accelerator: null, error: `The save hotkey ${settings.saveHotkey} is taken by another app. Pick another in Settings.` };
  }

  /** Changes the shortcut while the mode is on. Returns an error message or null. */
  change(accelerator: string, mainHotkey: string): string | null {
    if (accelerator === mainHotkey) return 'That is already the main hotkey. Pick a different shortcut.';
    return this.mgr.change(accelerator);
  }

  get accelerator(): string | null {
    return this.mgr.accelerator;
  }

  dispose(): void {
    this.mgr.dispose();
  }
}
