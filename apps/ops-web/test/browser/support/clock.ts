import type { BrowserContext, Page } from '@playwright/test';

/**
 * The one clock of the proof screens (run 4, Stage 3.8; the review of 5edada2). The stand-ins hold service dates around the third of November 2026 and a request is booked, confirmed
 * and built into a run for "today or later", so a page that reads the real clock says "Updated 14:31" in the proof screenshots and a date of the world is, some day, in the past of
 * the machine that runs the test. The browser's `Date` is fixed instead, from the first script of the page on and in every tab of a context, at the morning of the day the world
 * is set on. Only `Date` is fixed: timers, animation frames and the rest of the page run as they do, so nothing waits on a clock that does not move.
 */
export const TODAY = '2026-11-03';

/** The moment the proof screens think it is: the morning of `TODAY`, at the hub. */
export const FROZEN_NOW = new Date(`${TODAY}T08:30:00.000Z`);

/** Fixes the clock of the page, or of every page of the context, at `FROZEN_NOW`. Call it before the page goes anywhere. */
export async function freezeClock(target: Page | BrowserContext): Promise<void> {
  await target.clock.setFixedTime(FROZEN_NOW);
}
