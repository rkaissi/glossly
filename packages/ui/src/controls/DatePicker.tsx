import { useContext, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Ban, CalendarDays, ChevronDown, Sun } from 'lucide-react';
import { formatDue } from '../dates';
import { Calendar } from './Calendar';
import { MenuList } from './Menu';
import { dateShortcuts, dayLabel, monthOf, toDay, type Day } from './logic';
import { Popover } from './Popover';
import { WeekStartContext } from './week';

const SHORTCUT_ICONS: Record<string, ReactNode> = {
  Today: <CalendarDays size={16} strokeWidth={1.75} aria-hidden />,
  Tomorrow: <Sun size={16} strokeWidth={1.75} aria-hidden />,
  'Next week': <ArrowRight size={16} strokeWidth={1.75} aria-hidden />,
  'No date': <Ban size={16} strokeWidth={1.75} aria-hidden />,
};

/**
 * Our date picker (replaces `<input type="date">`): shortcuts (Today, Tomorrow, Next week,
 * No date) above a month calendar. `variant="chip"` is the due chip in list rows: "Today",
 * "Yesterday" in red when overdue, a faint "Add date" when there is none.
 */
export function DatePicker({
  value,
  onChange,
  label,
  variant = 'field',
  text,
  overdue,
  allowNone = true,
  noneText,
  disabled,
  className,
  tabIndex,
  title,
}: {
  value: Day | null;
  onChange: (day: Day | null) => void;
  label: string;
  /** field: a dropdown; chip: the due chip in rows; icon: a calendar icon button (row hover actions). */
  variant?: 'field' | 'chip' | 'icon';
  /** Override the trigger's text (a chip showing a time, or "Thu → Mon"). */
  text?: string;
  /** Override the chip's red overdue look (default: before today). */
  overdue?: boolean;
  allowNone?: boolean;
  /** The trigger's text without a date ("No date", "Add date", "Pick a day"). */
  noneText?: string;
  disabled?: boolean;
  className?: string;
  tabIndex?: number;
  /** A tooltip (the phrase the date was read from). */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const today = toDay(new Date());
  const ws = useContext(WeekStartContext);
  const [month, setMonth] = useState(monthOf(value ?? today));
  const [focusDay, setFocusDay] = useState(value ?? today);

  const show = () => {
    setMonth(monthOf(value ?? today));
    setFocusDay(value ?? today);
    setOpen(true);
  };
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) ref.current?.focus();
  };
  const pick = (d: Day | null) => {
    close(true);
    if (d !== value) onChange(d);
  };

  const due = value ? formatDue(value) : null;
  const isOverdue = overdue ?? (!!due && due.overdue);
  const shown = text ?? (variant === 'chip' ? (due ? due.label : (noneText ?? 'Add date')) : value ? dayLabel(value, today) : (noneText ?? 'No date'));
  const tone = variant === 'chip' ? (!value && !text ? ' empty' : isOverdue ? ' overdue' : value === today ? ' today' : '') : '';

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${variant === 'chip' ? 'date-chip' : variant === 'icon' ? 'icon-btn sm' : 'trigger'}${tone}${className ? ` ${className}` : ''}`}
        aria-label={`${label}: ${shown}`}
        title={title ?? (variant === 'icon' ? label : undefined)}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        tabIndex={tabIndex}
        data-control
        onClick={() => (open ? close(false) : show())}
      >
        {variant === 'icon' ? (
          <CalendarDays size={14} strokeWidth={1.75} aria-hidden />
        ) : (
          <span className="trigger-value">
            <CalendarDays size={variant === 'chip' ? 13 : 16} strokeWidth={1.75} aria-hidden />
            <span className="clip1">{shown}</span>
          </span>
        )}
        {variant === 'field' && <ChevronDown className="trigger-chevron" size={14} strokeWidth={1.75} aria-hidden />}
      </button>
      {open && (
        <Popover anchor={ref} onClose={close} label={label} align={variant === 'field' ? 'start' : 'end'} className="date-pop">
          <MenuList
            className="shortcuts"
            label="Shortcuts"
            autoFocus={false}
            noInitialActive
            items={dateShortcuts(today, ws)
              .filter((s) => allowNone || s.day !== null)
              .map((s) => ({ value: s.day ?? '', label: s.label, hint: s.hint, icon: SHORTCUT_ICONS[s.label] }))}
            onPick={(d) => pick(d || null)}
          />
          <Calendar month={month} onMonth={setMonth} focusDay={focusDay} onFocusDay={setFocusDay} today={today} selected={value} onPick={pick} />
        </Popover>
      )}
    </>
  );
}
