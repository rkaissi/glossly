import { app } from 'electron';
import type { Capture } from './capture';
import type { HelperManager } from './helper-manager';
import { logger } from './log';
import type { Services } from './services';

const log = logger('smoke');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summary(capture: Capture): Record<string, unknown> {
  const s = capture.state;
  return {
    mode: s.mode,
    side: s.placement?.side,
    hasSelection: s.hasSelection,
    words: s.wordCount,
    method: s.debug?.method,
    contextChars: (s.debug?.context_before.length ?? 0) + (s.debug?.context_after.length ?? 0),
    timings: s.debug?.timings,
    stage: s.slots?.stage,
    fallback: s.slots?.fallback,
    content_type: s.slots?.content_type,
    slot2: s.slots?.slot2.collection,
    slot3: s.slots?.slot3?.action,
    slot4: s.slots?.slot4?.action,
    notice: Boolean(s.notice),
  };
}

/**
 * Dev checks, logging counts and timings only:
 * - GLOSSLY_SMOKE=hotkey runs the hotkey path against the foreground app, then Save and Undo.
 * - GLOSSLY_SMOKE=auto waits for a mouse drag-select to show the pill, then expands it.
 */
export async function runSmoke({ helper, capture, services }: { helper: HelperManager; capture: Capture; services: Services }): Promise<void> {
  const mode = process.env.GLOSSLY_SMOKE;
  const delay = Number(process.env.GLOSSLY_SMOKE_DELAY_MS ?? 3000);
  for (let i = 0; i < 50 && !helper.isReady; i++) await sleep(100);
  log.info('helper', { ready: helper.isReady, mode });

  if (mode === 'auto') {
    for (let i = 0; i < delay / 50 && capture.state.mode === 'hidden'; i++) await sleep(50);
    log.info('pill state', summary(capture));
    if (capture.state.mode !== 'hidden') {
      await capture.expand(capture.state.sessionId);
      await sleep(800);
      log.info('expanded state', summary(capture));
    }
  } else {
    await sleep(delay);
    await capture.hotkey();
    await sleep(1500);
    const s = capture.state;
    log.info('hotkey state', summary(capture));
    if (s.hasSelection) {
      await capture.run(s.sessionId, { slot: 2 });
      log.info('panel', { mode: capture.state.mode, panel: capture.state.panel, timings: capture.state.debug?.timings });
      const before = services.store.listItems(1000).length;
      const saved = await capture.save(s.sessionId, '', undefined);
      const undone = services.save.undo(saved.itemId);
      log.info('save+undo', { collection: saved.collection, undone, itemsBefore: before, itemsAfter: services.store.listItems(1000).length });
    }
  }
  capture.close('smoke');
  await sleep(300);
  app.quit();
}
