import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';

/**
 * One of a few options, all visible, with a sliding highlight. Every option is as wide as the
 * widest label in bold, so selecting never moves anything, and the highlight is placed by CSS
 * alone (`--i` of `--n`), so resizing the window can't misplace it.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  disabled,
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    options.findIndex(([v]) => v === value),
  );
  const labels = options.map(([v]) => v).join('|');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = () => {
      const btns = [...el.querySelectorAll<HTMLButtonElement>('button')];
      const widest = Math.max(
        ...btns.map((b) => {
          const was = b.style.fontWeight;
          b.style.fontWeight = '600';
          const w = b.scrollWidth;
          b.style.fontWeight = was;
          return w;
        }),
      );
      el.style.setProperty('--cell', `${Math.ceil(widest)}px`);
    };
    el.style.removeProperty('--cell');
    size();
    void document.fonts?.ready.then(size);
  }, [labels]);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n]![0]);
    ref.current?.querySelectorAll<HTMLButtonElement>('button')[n]?.focus();
  };

  return (
    // --n and --i go in the first paint, so the highlight never slides in from the first option.
    <div ref={ref} className={`seg${size === 'sm' ? ' sm' : ''}`} role="radiogroup" aria-label={label} style={{ '--n': options.length, '--i': index } as CSSProperties} data-control>
      <span className="seg-thumb" aria-hidden />
      {options.map(([v, text], i) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          tabIndex={v === value ? 0 : -1}
          disabled={disabled}
          onClick={() => v !== value && onChange(v)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A square checkbox with an optional label; `mixed` draws a dash (some of a list selected). */
export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  children,
  className,
  tabIndex,
}: {
  checked: boolean | 'mixed';
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The accessible name when there are no children. */
  label?: string;
  children?: ReactNode;
  className?: string;
  tabIndex?: number;
}) {
  const box = (
    <button
      type="button"
      role="checkbox"
      className="cb"
      aria-checked={checked === 'mixed' ? 'mixed' : checked}
      aria-label={children ? undefined : label}
      disabled={disabled}
      tabIndex={tabIndex}
      data-control
      onClick={() => onChange(checked !== true)}
    >
      <Check size={12} strokeWidth={3} aria-hidden />
    </button>
  );
  if (!children) return box;
  return (
    <label className={`check-label${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}>
      {box}
      <span>{children}</span>
    </label>
  );
}

/** The round check that completes a task (pops when checked). */
export function TaskCheck({ checked, onChange, disabled, label, tabIndex }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string; tabIndex?: number }) {
  return (
    <button type="button" role="checkbox" className="tick" aria-checked={checked} aria-label={label} title={label} disabled={disabled} tabIndex={tabIndex} data-control onClick={() => onChange(!checked)}>
      <Check size={11} strokeWidth={3} aria-hidden />
    </button>
  );
}

/** On or off, taking effect at once. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" className="sw" aria-checked={checked} aria-label={label} disabled={disabled} data-control onClick={() => onChange(!checked)} />;
}

/** Radio choices as cards (the privacy choice, Save modes): a title and a line each. */
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T;
  options: readonly { value: T; title: string; desc: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  /** "stacked": one card per row, for long descriptions. */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n]!.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('button')[n]?.focus();
  };
  return (
    <div ref={ref} className={`choices${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="choice"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className="choice-dot" aria-hidden />
          <span>
            <strong>{o.title}</strong>
            <span className="muted small block">{o.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
