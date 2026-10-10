// The bar's keyboard map (spec, Core user flow). Pure, so it is unit-tested. Panels handle
// their own keys (Enter, Tab, Ctrl+C); Esc in a panel goes back to the bar. More lives in the
// Glossly menu at the left of the bar: Tab opens the menu with More's first item highlighted,
// and More's items then join what Enter and the arrow keys move through.
import type { ActionId, SlotsView } from '@glossly/core/api';

export type BarItem = { slot: 1 | 2 | 3 | 4 } | { action: ActionId };

export interface KeyInput {
  key: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
}

export interface BarKeyContext {
  /** From barItems(): what Enter and the arrow keys move through. */
  items: BarItem[];
  highlight: number;
  /** The Glossly menu (with More inside it) is open. */
  menuOpen: boolean;
}

export type BarCommand =
  | { kind: 'run'; target: BarItem }
  | { kind: 'highlight'; index: number }
  | { kind: 'menu'; open: boolean }
  | { kind: 'close' };

/** The bar's actionable items: slots 1 to 4, then More's actions while the menu is open. */
export function barItems(slots: SlotsView | null, hasSelection: boolean, menuOpen: boolean): BarItem[] {
  const items: BarItem[] = [{ slot: 1 }];
  if (!hasSelection) return items;
  items.push({ slot: 2 });
  if (slots?.slot3) items.push({ slot: 3 });
  if (slots?.slot4) items.push({ slot: 4 });
  if (menuOpen && slots) for (const m of slots.more) items.push({ action: m.action });
  return items;
}

export function sameItem(a: BarItem | undefined, b: BarItem): boolean {
  if (!a) return false;
  return 'slot' in a ? 'slot' in b && a.slot === b.slot : 'action' in b && a.action === b.action;
}

/** Maps a key press in the bar to a command, or null to let it through. */
export function barKey(k: KeyInput, c: BarKeyContext): BarCommand | null {
  if (k.ctrl || k.alt || k.meta) return null;
  const n = c.items.length;
  switch (k.key) {
    case '1':
    case '2':
    case '3':
    case '4': {
      const target: BarItem = { slot: Number(k.key) as 1 | 2 | 3 | 4 };
      return c.items.some((i) => sameItem(i, target)) ? { kind: 'run', target } : null;
    }
    case 'Enter': {
      const target = c.items[Math.min(Math.max(c.highlight, 0), n - 1)];
      return target ? { kind: 'run', target } : null;
    }
    case 'Tab':
      return { kind: 'menu', open: !c.menuOpen };
    // Down and Up move the same way, for the menu's vertical list.
    case 'ArrowRight':
    case 'ArrowDown':
      return { kind: 'highlight', index: (c.highlight + 1) % n };
    case 'ArrowLeft':
    case 'ArrowUp':
      return { kind: 'highlight', index: (c.highlight - 1 + n) % n };
    case 'Escape':
      return c.menuOpen ? { kind: 'menu', open: false } : { kind: 'close' };
    default:
      return null;
  }
}
