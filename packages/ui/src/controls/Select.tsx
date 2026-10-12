import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MenuList, type MenuItem } from './Menu';
import { Popover } from './Popover';

/**
 * Our dropdown (replaces `<select>`): a button showing the current value and a floating list
 * with check marks, groups, and type-ahead. Opens on click, ArrowDown or ArrowUp.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Pick one',
  disabled,
  size = 'md',
  className,
  tabIndex,
}: {
  value: T | null;
  options: MenuItem<T>[];
  onChange: (value: T) => void;
  /** The accessible name (the visible label lives next to it). */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) ref.current?.focus();
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`trigger${size === 'sm' ? ' sm' : ''}${className ? ` ${className}` : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        tabIndex={tabIndex}
        data-control
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="trigger-value">
          {current?.icon}
          {current ? <span className="clip1">{current.label}</span> : <span className="placeholder">{placeholder}</span>}
        </span>
        <ChevronDown className="trigger-chevron" size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <Popover anchor={ref} onClose={close} label={label} className="select-pop" scrolls>
          <MenuList
            items={options}
            selected={value ?? undefined}
            checks
            label={label}
            onPick={(v) => {
              close(true);
              if (v !== value) onChange(v);
            }}
          />
        </Popover>
      )}
    </>
  );
}
