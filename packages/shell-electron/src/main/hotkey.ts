import { globalShortcut } from 'electron';
import { logger } from './log';

const log = logger('hotkey');

/** The global hotkey: the only keyboard hook Glossly installs. */
export class HotkeyManager {
  private current: string | null = null;

  constructor(private readonly onPress: () => void) {}

  /** Registers the accelerator at launch. Returns false if another app holds it. */
  register(accelerator: string): boolean {
    try {
      if (globalShortcut.register(accelerator, this.onPress)) {
        this.current = accelerator;
        log.info('registered', { accelerator });
        return true;
      }
    } catch {
      /* invalid accelerator */
    }
    log.warn('could not register', { accelerator });
    return false;
  }

  /** Switches to a new accelerator, keeping the old one if the new one fails. Returns an error message or null. */
  change(accelerator: string): string | null {
    if (accelerator === this.current) return null;
    const old = this.current;
    if (old) globalShortcut.unregister(old);
    this.current = null;
    if (this.register(accelerator)) return null;
    if (old) this.register(old);
    return 'That hotkey is taken by another app or is not a valid shortcut. The old one is kept.';
  }

  get accelerator(): string | null {
    return this.current;
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.current = null;
  }
}
