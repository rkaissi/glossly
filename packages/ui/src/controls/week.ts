import { createContext } from 'react';
import type { WeekStart } from './logic';

/** The `weekStart` setting for every calendar grid below it (Monday when nothing provides it, as in the overlay). */
export const WeekStartContext = createContext<WeekStart>(1);
