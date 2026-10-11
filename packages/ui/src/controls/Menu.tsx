import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { menuMove, typeAhead } from './logic';
import { Popover } from './Popover';

export interface MenuItem<T> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Quiet text on the right: a weekday, "Fast", a shortcut. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** A small heading drawn above the first item of each group. */
  group?: string;
  /** A line above this item. */
  separator?: boolean;
}

/**
 * A list of options or actions that owns its keys: arrows, Home and End, Enter or Space to
 * pick, and type-ahead. `checks` draws a check column for the selected value (a Select).
 */
export function MenuList<T>({
  items,
  selected,
  checks = false,
  autoFocus = true,
  noInitialActive = false,
  label,
  className,
  onPick,
}: {
  items: MenuItem<T>[];
  selected?: T;
  checks?: boolean;
  autoFocus?: boolean;
  /** Start with nothing highlighted (lists inside a picker, until the keyboard is used). */
  noInitialActive?: boolean;
  label?: string;
  className?: string;
  onPick: (value: T) => void;
}) {
  const disabled = items.map((i) => !!i.disabled);
  const selIndex = items.findIndex((i) => i.value === selected);
  const [active, setActive] = useState(() => (noInitialActive ? -1 : selIndex >= 0 ? selIndex : (menuMove('Home', -1, disabled) ?? -1)));
  const typed = useRef({ typed: '', at: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent) => {
    const next = menuMove(e.key, active, disabled);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = items[active];
      if (it && !it.disabled) onPick(it.value);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const r = typeAhead(typed.current, e.key, Date.now(), items.map((i) => i.label), disabled);
      typed.current = r;
      if (r.index !== null) setActive(r.index);
    }
  };

  return (
    <div
      ref={listRef}
      className={`pop-menu${className ? ` ${className}` : ''}`}
      role={checks ? 'listbox' : 'menu'}
      aria-label={label}
      tabIndex={0}
      data-autofocus={autoFocus || undefined}
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => (
        <Fragment key={i}>
          {it.separator && <div className="pop-sep" role="separator" />}
          {it.group && it.group !== items[i - 1]?.group && <div className="pop-head">{it.group}</div>}
          <div
            id={`${id}-${i}`}
            data-index={i}
            role={checks ? 'option' : 'menuitem'}
            aria-selected={checks ? it.value === selected : undefined}
            aria-disabled={it.disabled || undefined}
            className={`pop-item${i === active ? ' active' : ''}${it.danger ? ' danger' : ''}`}
            onMouseMove={() => !it.disabled && active !== i && setActive(i)}
            onClick={() => !it.disabled && onPick(it.value)}
          >
            {checks && <Check className="pop-check" size={16} strokeWidth={2} aria-hidden />}
            {it.icon}
            <span className="pop-label">{it.label}</span>
            {it.hint && <span className="pop-hint">{it.hint}</span>}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** A row's "…" button with its actions (Change date, Open person, Delete). */
export function ActionMenu<T>({ items, label = 'More', onPick, size = 'sm' }: { items: MenuItem<T>[]; label?: string; onPick: (value: T) => void; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) ref.current?.focus();
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`icon-btn${size === 'sm' ? ' sm' : ''}${open ? ' open' : ''}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-control
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={size === 'sm' ? 14 : 16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <Popover anchor={ref} align="end" onClose={close} label={label}>
          <MenuList
            items={items}
            label={label}
            onPick={(v) => {
              close(true);
              onPick(v);
            }}
          />
        </Popover>
      )}
    </>
  );
}
