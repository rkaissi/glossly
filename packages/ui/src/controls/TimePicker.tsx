import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { formatTime, menuMove, nearestStep, parseTime, TIME_STEPS, type Time } from './logic';
import { Popover } from './Popover';

/**
 * Our time picker (replaces `<input type="time">`): type "3pm", "15:30", or "3:45p", or pick
 * from a list in 15-minute steps as wide as the field. Focus stays in the field; arrows move
 * through the list, Enter commits, an unreadable entry goes back to the last good time.
 */
export function TimePicker({
  value,
  onChange,
  label,
  disabled,
  size = 'md',
  placeholder,
  allowEmpty = false,
  tabIndex,
}: {
  /** "HH:MM", or "" for no time (with `allowEmpty`). */
  value: Time;
  onChange: (t: Time) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  placeholder?: string;
  /** Clearing the field commits "" (an event becomes all day). */
  allowEmpty?: boolean;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ? formatTime(value) : '');
  const [active, setActive] = useState(-1);
  const field = useRef<HTMLLabelElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setText(value ? formatTime(value) : ''), [value]);
  useEffect(() => {
    if (!open) return;
    const el = list.current?.querySelector<HTMLElement>(active >= 0 ? `[data-index="${active}"]` : '[aria-selected="true"]');
    el?.scrollIntoView({ block: active >= 0 ? 'nearest' : 'center' });
  }, [open, active]);

  const read = (s: string): Time | null => (allowEmpty && !s.trim() ? '' : parseTime(s));
  const commit = (t: Time | null) => {
    if (t === null) return setText(value ? formatTime(value) : '');
    if (t === '') {
      setText('');
      if (value) onChange('');
      return;
    }
    setText(formatTime(t));
    if (t !== value) onChange(t);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const selected = value ? nearestStep(value) : null;

  return (
    <>
      <label ref={field} className={`time-field${size === 'sm' ? ' sm' : ''}${disabled ? ' disabled' : ''}`} data-control>
        <Clock size={size === 'sm' ? 14 : 16} strokeWidth={1.75} aria-hidden />
        <input
          ref={input}
          value={text}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          placeholder={placeholder}
          tabIndex={tabIndex}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
          }}
          onFocus={(e) => {
            e.target.select();
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => {
            commit(read(text));
            close();
          }}
          onKeyDown={(e) => {
            const next = menuMove(e.key, active < 0 && selected ? TIME_STEPS.indexOf(selected) : active, TIME_STEPS.map(() => false));
            if (next !== null && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setOpen(true);
              setActive(next);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              commit(active >= 0 ? TIME_STEPS[active]! : read(text));
              close();
            }
          }}
        />
      </label>
      {open && (
        <Popover anchor={field} onClose={close} focus={false} matchWidth className="time-pop" label={label} scrolls>
          <div className="pop-menu time-list" role="listbox" aria-label={label} ref={list} onMouseDown={(e) => e.preventDefault()}>
            {TIME_STEPS.map((t, i) => (
              <div
                key={t}
                data-index={i}
                role="option"
                aria-selected={t === selected}
                className={`pop-item${i === active ? ' active' : ''}`}
                onMouseMove={() => active !== i && setActive(i)}
                onClick={() => {
                  commit(t);
                  close();
                }}
              >
                {formatTime(t)}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
