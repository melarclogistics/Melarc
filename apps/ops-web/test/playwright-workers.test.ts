import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A run that launches WebKit headed makes it with one worker, and no other run is slowed for it. Two headed WebKit browsers under CI's one virtual display put their windows on top of each other; the page underneath is
 * hidden to itself and a toast's timer never runs out (the hosted run of main of 17 November 2026: `kit.spec.ts`, "stays with an action until it is dismissed, and goes by itself without one", twice in a row, in
 * the same shard). `playwright.config.ts` says why in full. Without this, the worker count is a number that anyone may put back to two for speed.
 */
async function workersWith(browsers: string, headed: string): Promise<unknown> {
  vi.resetModules();
  vi.stubEnv('MELARC_BROWSERS', browsers);
  vi.stubEnv('MELARC_WEBKIT_HEADED', headed);
  vi.stubEnv('MELARC_BROWSER_SHARD', '');
  const loaded = await import('../playwright.config');
  return loaded.default.workers;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('how many workers the browser tests use', () => {
  // Break caught: two workers where WebKit is launched headed, which is the run that failed a toast's test twice in a row for a covered window.
  it('is one where WebKit is launched headed, alone or beside another engine', async () => {
    expect(await workersWith('webkit', '1')).toBe(1);
    expect(await workersWith('chromium,webkit', '1')).toBe(1);
    expect(await workersWith('webkit,firefox', '1')).toBe(1);
  });

  // Break caught: the slowdown given to every run that sets the value: the job that holds Firefox is handed the value too, and Firefox has no window to cover.
  it('is two for every run that does not launch WebKit headed', async () => {
    expect(await workersWith('firefox', '1')).toBe(2);
    expect(await workersWith('chromium', '1')).toBe(2);
    expect(await workersWith('webkit', '')).toBe(2);
    expect(await workersWith('webkit', '0')).toBe(2);
    expect(await workersWith('', '')).toBe(2);
  });

  it('refuses a value that is not one, as it always did, and does not read it as "not set"', async () => {
    await expect(workersWith('webkit', 'yes')).rejects.toThrow(/MELARC_WEBKIT_HEADED/);
  });
});
