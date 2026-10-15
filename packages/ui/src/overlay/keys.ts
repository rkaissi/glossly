// The bar's keyboard map (spec, Core user flow). The number keys follow the buttons'
// order on screen (`slotKey`). Pure, so it is unit-tested. Panels handle
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

/** The bar's actionable items: slots 1 to 4 (no Save without a selection), then More's actions while the menu is open. */
export function barItems(slots: SlotsView | null, hasSelection: boolean, menuOpen: boolean): BarItem[] {
  const items: BarItem[] = [{ slot: 1 }];
  // Nothing selected: Save is hidden, and slots 3 and 4 hold Search and the paste actions.
  if (hasSelection) items.push({ slot: 2 });
  if (slots?.slot3) items.push({ slot: 3 });
  if (slots?.slot4) items.push({ slot: 4 });
  if (menuOpen && slots) for (const m of slots.more) items.push({ action: m.action });
  return items;
}

/**
 * The number shown on a slot button and the key that runs it: its position on the bar, so
 * the empty bar (no Save) reads 1 Ask, 2 Search, 3 Paste snippets rather than skipping 2.
 */
export function slotKey(items: BarItem[], slot: 1 | 2 | 3 | 4): number {
  return items.filter((i) => 'slot' in i).findIndex((i) => 'slot' in i && i.slot === slot) + 1;
}

export function sameItem(a: BarItem | undefined, b: BarItem): boolean {
  if (!a) return false;
  return 'slot' in a ? 'slot' in b && a.slot === b.slot : 'action' in b && a.action === b.action;
}

/** The slot a number key runs, by its position on the bar (`slotKey`). */
function slotAt(items: BarItem[], key: string): BarItem | undefined {
  return /^[1-4]$/.test(key) ? items.filter((i) => 'slot' in i)[Number(key) - 1] : undefined;
}

/**
 * Maps a key press in an open panel to a command, or null to let it through to the panel. The
 * plain number keys type into the panel's box (the empty bar opens on Search, focused), so
 * Alt+1 to 4 opens another slot from there; Esc back to the bar makes the plain ones work again.
 * The open panel's own slot does nothing.
 */
export function panelKey(k: KeyInput, items: BarItem[], openSlot: 1 | 2 | 3 | 4 | null): BarCommand | null {
  if (!k.alt || k.ctrl || k.meta) return null;
  const target = slotAt(items, k.key);
  return target && !('slot' in target && target.slot === openSlot) ? { kind: 'run', target } : null;
}

/** Maps a key press in the bar to a command, or null to let it through. */
export function barKey(k: KeyInput, c: BarKeyContext): BarCommand | null {
  if (k.ctrl || k.meta) return null;
  // Alt+number works on the bar too, the same as in a panel.
  if (k.alt) {
    const target = slotAt(c.items, k.key);
    return target ? { kind: 'run', target } : null;
  }
  const n = c.items.length;
  switch (k.key) {
    case '1':
    case '2':
    case '3':
    case '4': {
      const target = slotAt(c.items, k.key);
      return target ? { kind: 'run', target } : null;
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
