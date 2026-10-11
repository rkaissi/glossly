import { createContext } from 'react';

/**
 * The overlay window is only as tall as its content, so a popover would be cut off at the
 * window's edge. The overlay provides this: a popover that doesn't fit says how tall the window
 * must be (`below` when the window grows downward, `above` when the bar sits above the selection
 * and the window grows upward), and null when it closes. The overlay grows its content to that
 * while the popover is open. The settings window provides nothing; popovers there fit inside
 * the window as they are.
 */
export type RequestRoom = (id: number, need: { below: number; above: number } | null) => void;

export const RoomContext = createContext<RequestRoom | null>(null);
