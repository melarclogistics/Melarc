import { chromium, type Page } from '@playwright/test';

/**
 * Runs `run` on a page whose scrollbars take room, as the Product Owner's Windows draws them (17px). Playwright hides the scrollbars of a headless Chromium (`--hide-scrollbars`), so a test of
 * what a scrollbar does to the layout (the table's fit, which depends on the width of its box) starts Chromium as that machine runs it, in a browser of its own that is closed afterwards. The other
 * engines are run as they are, on `provided`, and the test skips itself where their scrollbar takes no room (`page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)` is 0).
 */
export async function withScrollbars(
  provided: Page,
  browserName: string,
  baseURL: string | undefined,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const own =
    browserName === 'chromium'
      ? await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--hide-scrollbars'] })
      : undefined;
  try {
    const page = own === undefined ? provided : await (await own.newContext({ baseURL })).newPage();
    await run(page);
  } finally {
    await own?.close();
  }
}
