import { useRef, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, addMonths, monthGrid, monthLabel, WEEKDAYS, type Day } from './logic';

/**
 * One month as a grid of days (Monday first). Arrow keys move the focused day, PageUp and
 * PageDown move a month, Enter picks. `dayClass` adds range styling; `onHover` previews it.
 */
export function Calendar({
  month,
  onMonth,
  focusDay,
  onFocusDay,
  today,
  selected,
  dayClass,
  onPick,
  onHover,
  nav = 'both',
}: {
  month: Day;
  onMonth: (month: Day) => void;
  focusDay: Day;
  onFocusDay: (day: Day) => void;
  today: Day;
  selected?: Day | null;
  dayClass?: (day: Day) => string;
  onPick: (day: Day) => void;
  onHover?: (day: Day) => void;
  /** Which month arrows to draw (two months side by side share them). */
  nav?: 'both' | 'prev' | 'next' | 'none';
}) {
  const grid = useRef<HTMLDivElement>(null);
  const inMonth = (d: Day) => d.slice(0, 7) === month.slice(0, 7);

  const moveFocus = (d: Day) => {
    onFocusDay(d);
    if (!inMonth(d)) onMonth(`${d.slice(0, 7)}-01`);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-day="${d}"]`)?.focus());
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) {
      e.preventDefault();
      moveFocus(addDays(focusDay, step));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const target = addMonths(focusDay, e.key === 'PageUp' ? -1 : 1);
      const day = Math.min(Number(focusDay.slice(8)), new Date(Number(target.slice(0, 4)), Number(target.slice(5, 7)), 0).getDate());
      moveFocus(`${target.slice(0, 8)}${String(day).padStart(2, '0')}`);
    } else if (e.key === 'Enter' || e.key === ' ') {
      const d = (e.target as HTMLElement).dataset.day;
      if (d) {
        e.preventDefault();
        onPick(d);
      }
    }
  };

  return (
    <div className="cal">
      <div className="cal-head">
        <span className="cal-month">{monthLabel(month)}</span>
        {(nav === 'both' || nav === 'prev') && (
          <button type="button" className="icon-btn sm" aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))}>
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {(nav === 'both' || nav === 'next') && (
          <button type="button" className="icon-btn sm" aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))}>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      <div className="cal-grid" role="grid" aria-label={monthLabel(month)} ref={grid} onKeyDown={onKeyDown}>
        {WEEKDAYS.map((w) => (
          <span key={w} className="cal-dow" aria-hidden>
            {w}
          </span>
        ))}
        {monthGrid(month).map((d) => {
          const cls = ['cal-day', !inMonth(d) && 'out', d === today && 'today', d === selected && 'sel', dayClass?.(d)].filter(Boolean).join(' ');
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              className={cls}
              data-day={d}
              data-autofocus={d === focusDay || undefined}
              tabIndex={d === focusDay ? 0 : -1}
              aria-selected={d === selected}
              aria-label={new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8))).toDateString()}
              onClick={() => onPick(d)}
              onMouseEnter={onHover && (() => onHover(d))}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
