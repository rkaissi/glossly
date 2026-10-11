import { useContext, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { anchorHidden, placePopover, roomNeeded, type Rect } from './logic';
import { RoomContext } from './room';

let nextRoomId = 1;

/** The nearest ancestor that scrolls, whose box clips the anchor; null means the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

const toRect = (r: DOMRect): Rect => ({ top: r.top, left: r.left, bottom: r.bottom, right: r.right });

/**
 * The one floating layer under every control (Step 20.1): placed below or above its anchor
 * inside the window, kept attached while anything scrolls or the window resizes, closed by
 * Esc (focus goes back to the anchor), a click outside, or the anchor scrolling out of view.
 * Keys pressed inside don't reach the panel or bar behind it.
 */
export function Popover({
  anchor,
  onClose,
  align = 'start',
  matchWidth = false,
  focus = true,
  className,
  label,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  /** `restoreFocus` is true for Esc and picks, false for clicks outside and scrolling away. */
  onClose: (restoreFocus: boolean) => void;
  align?: 'start' | 'end';
  /** As wide as the anchor (the time list). */
  matchWidth?: boolean;
  /** Move focus into the popover on open (to `[data-autofocus]`, else the popover itself). */
  focus?: boolean;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const requestRoom = useContext(RoomContext);
  const roomId = useRef(0);
  if (!roomId.current) roomId.current = nextRoomId++;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const id = useId();

  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    if (!el || !a) return;
    const clipEl = scrollParent(a);
    let asked = false;

    const place = () => {
      const ar = a.getBoundingClientRect();
      // The window's client area, without its scrollbar.
      const view = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
      const clip = clipEl ? toRect(clipEl.getBoundingClientRect()) : { top: 0, left: 0, bottom: view.h, right: view.w };
      if (anchorHidden(toRect(ar), clip)) return closeRef.current(false);
      if (matchWidth) el.style.width = `${ar.width}px`;
      el.style.maxHeight = '';
      const size = { w: el.offsetWidth, h: el.scrollHeight };
      // Ask once for the room it lacks and keep it while open, so the window doesn't flap.
      if (requestRoom && !asked) {
        const need = roomNeeded(toRect(ar), size.h, view.h);
        if (need) {
          asked = true;
          requestRoom(roomId.current, need);
        }
      }
      const p = placePopover(toRect(ar), size, view, align);
      el.style.top = `${p.top}px`;
      el.style.left = `${p.left}px`;
      el.style.maxHeight = p.maxHeight === null ? '' : `${p.maxHeight}px`;
      el.dataset.side = p.side;
      el.dataset.align = align;
    };
    place();
    if (focus) ((el.querySelector('[data-autofocus]') as HTMLElement | null) ?? el).focus({ preventScroll: true });

    const ro = new ResizeObserver(place);
    ro.observe(el);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(true);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !a.contains(t)) closeRef.current(false);
    };
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    addEventListener('keydown', onKey, true);
    addEventListener('mousedown', onDown, true);
    return () => {
      ro.disconnect();
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
      removeEventListener('keydown', onKey, true);
      removeEventListener('mousedown', onDown, true);
      requestRoom?.(roomId.current, null);
    };
  }, [anchor, align, matchWidth, focus, requestRoom]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      className={`popover${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
