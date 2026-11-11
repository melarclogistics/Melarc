import type { ConsoleMessage, Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import {
  guardAgainstPermissionKeys,
  type GuardedContext,
} from './browser/support/permission-key-guard';
import { watchPage } from './browser/support/page';
import { KEY_PATTERN_FLAGS, keyPatternSource } from './support/permission-catalogue';
import { PERMISSION_KEY_LOG_PREFIX, watchForPermissionKeys } from './support/permission-key-watch';

/** The two warnings as Firefox 1543 wrote them to a console that Playwright was reading (logs of the run of 9 November 2026). */
const BOUNCE_TRACKER =
  '[JavaScript Warning: "“127.0.0.1” has been classified as a bounce tracker. If it does not receive user activation within the next 3,600 seconds it will have its state purged."]';
const SCROLL_LINKED =
  '[JavaScript Warning: "This site appears to use a scroll-linked positioning effect. This may not work well with asynchronous panning; see https://firefox-source-docs.mozilla.org/performance/scroll-linked_effects.html for further details and to join the discussion on related tools and features!" {file: "http://127.0.0.1:4274/__showcase/kit/overlays" line: 0}]';

type Say = (type: 'warning' | 'error' | 'log', text: string) => void;

/** A page that is only what `watchPage` asks of one: its engine, a console that it can be told things in, and a place for an init script. */
function pageOf(engine: 'chromium' | 'firefox' | 'webkit' | null): {
  readonly page: Page;
  readonly say: Say;
} {
  const handlers = new Map<string, (argument: unknown) => void>();
  const fake = {
    on: (event: string, handler: (argument: unknown) => void): void => {
      handlers.set(event, handler);
    },
    // The page also gets the watch for a permission key (`watchForPermissionKeys`), which a page of this kind has no document to run in.
    addInitScript: (): Promise<void> => Promise.resolve(),
    context: () => ({
      browser: () => (engine === null ? null : { browserType: () => ({ name: () => engine }) }),
    }),
  };
  const say: Say = (type, text) => {
    handlers.get('console')?.({
      type: () => type,
      text: () => text,
      location: () => ({ url: '' }),
    });
  };
  return { page: fake as unknown as Page, say };
}

describe('watchPage: what Firefox says of its own accord', () => {
  // Break caught: a Firefox run failing on a heuristic of the engine that no change of ours can prevent, so that the check means nothing there (run of 9 November 2026: the
  // bounce tracker on the first page of a test, the scroll-linked effect on every popover of the kit).
  it('does not count the bounce-tracker classification of the test origin or the scroll-linked positioning effect, on Firefox', () => {
    const { page, say } = pageOf('firefox');
    const seen = watchPage(page);

    say('warning', BOUNCE_TRACKER);
    say('warning', SCROLL_LINKED);

    expect(seen.problems).toEqual([]);
  });

  // Break caught: a filter that has grown into "Firefox's warnings are ignored": any other warning, a changed wording, another host or another page's own origin is a problem.
  it('still counts every other warning on Firefox', () => {
    const { page, say } = pageOf('firefox');
    const seen = watchPage(page);

    const others = [
      '[JavaScript Warning: "Some other warning of the engine."]',
      BOUNCE_TRACKER.replace('127.0.0.1', 'localhost'),
      BOUNCE_TRACKER.replace('3,600 seconds', '60 seconds'),
      `${BOUNCE_TRACKER} And something more.`,
      SCROLL_LINKED.replace('http://127.0.0.1:4274/', 'https://example.com/'),
      SCROLL_LINKED.replace('scroll-linked positioning effect', 'scroll-linked effect'),
      'Another warning of the page: a key is missing.',
    ];
    for (const text of others) say('warning', text);

    expect(seen.problems).toEqual(others.map((text) => `console warning: ${text} ()`));
  });

  // Break caught: the same words as an error being let through: only a warning is Firefox's heuristic.
  it('still counts the same words when they are an error', () => {
    const { page, say } = pageOf('firefox');
    const seen = watchPage(page);

    say('error', BOUNCE_TRACKER);
    say('error', SCROLL_LINKED);

    expect(seen.problems).toEqual([
      `console error: ${BOUNCE_TRACKER} ()`,
      `console error: ${SCROLL_LINKED} ()`,
    ]);
  });

  // Break caught: the filter applied to every engine: a Chromium or a WebKit that wrote these words would be reporting something of ours.
  it.each(['chromium', 'webkit'] as const)('still counts both on %s', (engine) => {
    const { page, say } = pageOf(engine);
    const seen = watchPage(page);

    say('warning', BOUNCE_TRACKER);
    say('warning', SCROLL_LINKED);

    expect(seen.problems).toEqual([
      `console warning: ${BOUNCE_TRACKER} ()`,
      `console warning: ${SCROLL_LINKED} ()`,
    ]);
  });

  // Break caught: a page whose engine is not known (a browser with no `Browser` object) taken for Firefox.
  it('counts both when the engine is not known', () => {
    const { page, say } = pageOf(null);
    const seen = watchPage(page);

    say('warning', BOUNCE_TRACKER);

    expect(seen.problems).toHaveLength(1);
  });

  // Break caught: the rest of what the watch records changed by the filter: an error, and a warning that is not Firefox's, on Firefox.
  it('still records an error of the page on Firefox', () => {
    const { page, say } = pageOf('firefox');
    const seen = watchPage(page);

    say('error', 'Uncaught TypeError: x is undefined');
    say('log', 'A log line is not a problem.');

    expect(seen.problems).toEqual(['console error: Uncaught TypeError: x is undefined ()']);
  });
});

/** A browser context that is only what the guard asks of one: a console to be told things in, an init script to be handed, and pages that answer a round trip. */
function contextOf(pageCount = 1) {
  type Message = Pick<ConsoleMessage, 'type' | 'text'>;
  const listeners: ((message: Message) => void)[] = [];
  const installed: unknown[][] = [];
  const evaluated: number[] = [];
  const pages = Array.from({ length: pageCount }, (_unused, index) => ({
    evaluate: () => {
      evaluated.push(index);
      return Promise.resolve(undefined);
    },
  }));
  const context: GuardedContext = {
    addInitScript: (...args) => {
      installed.push(args);
      return Promise.resolve();
    },
    on: (_event, listener) => {
      listeners.push(listener);
    },
    pages: () => pages,
  };
  const say = (type: ReturnType<ConsoleMessage['type']>, text: string): void => {
    for (const listener of listeners) listener({ type: () => type, text: () => text });
  };
  return { context, say, installed, evaluated };
}

describe('guardAgainstPermissionKeys: every key drawn on any page of the test, whether or not the test looked (run 7, Stage 2.3)', () => {
  // Break caught: a guard that listens to nothing, or to the wrong text, so that a key drawn in a refusal test that asserts nothing about it passes.
  it('gives every key a page wrote to its console as an error, and nothing else', async () => {
    const { context, say } = contextOf();
    const guard = await guardAgainstPermissionKeys(context);

    say('error', `${PERMISSION_KEY_LOG_PREFIX}pickup.read in the text of <p>`);
    say('error', 'Uncaught TypeError: x is undefined');
    say('warning', `${PERMISSION_KEY_LOG_PREFIX}staff.read in the text of <p>`);
    say('log', `${PERMISSION_KEY_LOG_PREFIX}staff.read in the text of <p>`);

    expect(await guard.finish()).toEqual([
      `${PERMISSION_KEY_LOG_PREFIX}pickup.read in the text of <p>`,
    ]);
  });

  it('gives nothing for a test whose pages drew no key', async () => {
    const { context, say } = contextOf();
    const guard = await guardAgainstPermissionKeys(context);

    say('error', 'Failed to load resource: the server responded with a status of 403');

    expect(await guard.finish()).toEqual([]);
  });

  // Break caught: a watch put on the page the test opened first and not on the context, so that a second page, a popup or a reload after a navigation is not watched.
  it('puts the watch on the context, with the catalogue and its logging on, so that every document of every page has it', async () => {
    const { context, installed } = contextOf();
    await guardAgainstPermissionKeys(context);

    expect(installed).toEqual([
      [watchForPermissionKeys, { source: keyPatternSource(), flags: KEY_PATTERN_FLAGS, log: true }],
    ]);
  });

  // Break caught: the keys read without asking the pages first, so that one drawn in the last moments of the test is not heard.
  it('asks every page for a round trip before it answers, so that what they said last is heard', async () => {
    const { context, evaluated } = contextOf(3);
    const guard = await guardAgainstPermissionKeys(context);

    await guard.finish();

    expect(evaluated.sort()).toEqual([0, 1, 2]);
  });

  // Break caught: the text the guard listens for changed in one place and not the other, so that the watch speaks and the guard does not hear.
  it('listens for the text the watch writes', () => {
    expect(watchForPermissionKeys.toString()).toContain(PERMISSION_KEY_LOG_PREFIX);
  });
});
