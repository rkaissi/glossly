import { useContext, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { Calendar } from './Calendar';
import { MenuList } from './Menu';
import { addMonths, dayLabel, monthOf, ordered, quickRanges, rangeLabel, rangeRole, toDay, type Day, type DayRange } from './logic';
import { Popover } from './Popover';
import { WeekStartContext } from './week';

/**
 * Our date range picker: quick ranges on the left, two months (one in a narrow window), the
 * range previewed while hovering for the last day, then Apply. Hovering only restyles days, so
 * a click always lands on the day under the mouse.
 */
export function DateRangePicker({ value, onChange, label, disabled, className }: { value: DayRange; onChange: (range: DayRange) => void; label: string; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const today = toDay(new Date());
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) ref.current?.focus();
  };
  const shown = rangeLabel(value, today);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`trigger range-trigger${className ? ` ${className}` : ''}`}
        aria-label={`${label}: ${shown}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        data-control
        onClick={() => setOpen((o) => !o)}
      >
        <span className="trigger-value">
          <CalendarDays size={16} strokeWidth={1.75} aria-hidden />
          <span className="clip1">{shown}</span>
        </span>
        <ChevronDown className="trigger-chevron" size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <Popover anchor={ref} onClose={close} label={label} className="range-pop">
          <RangeBody
            value={value}
            today={today}
            onCancel={() => close(true)}
            onApply={(r) => {
              close(true);
              if (r.from !== value.from || r.to !== value.to) onChange(r);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function RangeBody({ value, today, onApply, onCancel }: { value: DayRange; today: Day; onApply: (r: DayRange) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<DayRange>(value);
  /** The first day while the second is being picked. */
  const [anchorDay, setAnchorDay] = useState<Day | null>(null);
  const [hover, setHover] = useState<Day | null>(null);
  const [left, setLeft] = useState(monthOf(value.from));
  const [focusDay, setFocusDay] = useState(value.from);
  const two = innerWidth >= 720;

  const preview = anchorDay ? ordered(anchorDay, hover ?? anchorDay) : draft;
  const dayClass = (d: Day) => {
    const r = rangeRole(d, preview);
    return [r.inside && 'in-range', r.start && 'range-start', r.end && 'range-end'].filter(Boolean).join(' ');
  };
  const pick = (d: Day) => {
    if (!anchorDay) {
      setAnchorDay(d);
      setHover(d);
    } else {
      setDraft(ordered(anchorDay, d));
      setAnchorDay(null);
    }
  };
  const quick = quickRanges(today, useContext(WeekStartContext));
  const current = anchorDay ? undefined : quick.find((q) => q.range.from === draft.from && q.range.to === draft.to)?.label;

  const cal = (month: Day, nav: 'both' | 'prev' | 'next') => (
    <Calendar
      month={month}
      onMonth={(m) => setLeft(nav === 'next' ? addMonths(m, -1) : m)}
      focusDay={focusDay}
      onFocusDay={setFocusDay}
      today={today}
      dayClass={dayClass}
      onPick={pick}
      onHover={anchorDay ? setHover : undefined}
      nav={nav}
    />
  );

  return (
    <div className="range">
      <MenuList
        key={current ?? ''}
        className="range-quick"
        label="Quick ranges"
        checks
        autoFocus={false}
        noInitialActive
        selected={current}
        items={quick.map((q) => ({ value: q.label, label: q.label }))}
        onPick={(l) => {
          const r = quick.find((q) => q.label === l)!.range;
          setDraft(r);
          setAnchorDay(null);
          setLeft(monthOf(r.from));
          setFocusDay(r.from);
        }}
      />
      <div className="range-main">
        <div className="range-months">
          {two ? (
            <>
              {cal(left, 'prev')}
              {cal(addMonths(left, 1), 'next')}
            </>
          ) : (
            cal(left, 'both')
          )}
        </div>
        <div className="range-foot">
          <span className="muted small grow">{anchorDay ? 'Pick the last day' : `${dayLabel(draft.from, today)} – ${dayLabel(draft.to, today)}`}</span>
          <button type="button" className="ghost sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary sm" disabled={!!anchorDay} onClick={() => onApply(draft)}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
