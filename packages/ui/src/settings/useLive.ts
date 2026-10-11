import { useEffect, useState } from 'react';
import { glossly } from '../bridge';

/** Re-runs `load` now and whenever people or tasks change anywhere. Undefined while loading. */
export function useLive<T>(load: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const run = () => void load().then((v) => live && setValue(v));
    run();
    const off = glossly.on('people:changed', run);
    return () => {
      live = false;
      off();
    };
  }, [load]);
  return value;
}
