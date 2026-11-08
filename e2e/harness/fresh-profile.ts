import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * A private copy of a browser profile for one test (S0.23; the review of 12 October 2026, F04). Firefox trusts the test CA through a
 * profile that holds it (`cert9.db`), and a persistent context launched from a profile keeps what the page stores there: cookies,
 * local storage, the cache. Closing such a context does not delete the profile, so a profile shared by tests carries one test's
 * state into the next, which a fresh context of the other engines never does. So the seeded profile is a **template that no browser
 * is launched from**, and every test is given a copy of it that it alone uses and that is removed when the test ends: it keeps the
 * CA and nothing the previous test wrote.
 *
 * The copy is made beside the template, below the run's own directory (outside the checkout, private to its owner, removed with the
 * run). It is removed in a `finally`, whatever the test did; the evidence a failing test keeps is what Playwright attaches, which a
 * spec that shows a secret does not record, and never the profile.
 */
export interface FreshProfile {
  readonly directory: string;
  /** Removes the copy. Safe to call twice. */
  remove(): void;
}

/** Copies the template into a new private directory in `parent`, which is beside it and never inside it. */
export function copyProfile(template: string, parent: string = dirname(template)): FreshProfile {
  if (!existsSync(template) || !statSync(template).isDirectory()) {
    throw new Error('The profile to copy is not a directory: the engine was not seeded');
  }
  const inside = relative(template, parent);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error('A profile is copied beside its template, never into it');
  }
  const directory = mkdtempSync(join(parent, 'firefox-profile-copy-'));
  try {
    chmodSync(directory, 0o700);
    cpSync(template, directory, {
      recursive: true,
      force: true,
      errorOnExist: false,
      verbatimSymlinks: true,
    });
  } catch (failure) {
    rmSync(directory, { recursive: true, force: true });
    throw failure;
  }
  return {
    directory,
    remove: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export interface Closable {
  close(): Promise<void>;
}

/**
 * The teardown of a test’s browser profile failed (the context would not close, or the copy could not be removed). A test that
 * passed is failed by it: a copy left on disk or a context left open is state that the next test could meet, and a harness that
 * hides it reports a pass it cannot vouch for.
 */
export class ProfileTeardownError extends Error {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super(
      `The browser profile of a test could not be cleaned up: ${failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join('; ')}`,
    );
    this.name = 'ProfileTeardownError';
    this.failures = failures;
  }
}

export interface FreshProfileOptions {
  /** Where the copy is made. Beside the template unless told otherwise. */
  readonly parent?: string;
  /** Says what could not be cleaned up when the test had already failed. Standard error unless told otherwise. */
  readonly report?: (message: string) => void;
  /** Makes the copy. `copyProfile`; a test supplies another to show what happens when the copy cannot be removed. */
  readonly copy?: (template: string, parent: string) => FreshProfile;
}

const toStandardError = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * Launches a context from a fresh copy of the template, hands it to `use`, and closes it and removes the copy when `use` ends,
 * however it ends. `launch` is the engine’s persistent launch (`launchPersistentContext`); it is never given the template.
 *
 * Nothing in the teardown is swallowed. Both steps run whatever happens (the copy goes even if the context will not close), and
 * then: a test that **passed** fails with a `ProfileTeardownError` naming every step that failed; a test that **failed** keeps its
 * own failure, the very same error, and the teardown’s is reported beside it (`report`), so the cause the reader needs is the
 * first thing they see and the second is not lost.
 */
export async function withFreshProfile<C extends Closable, T>(
  template: string,
  launch: (directory: string) => Promise<C>,
  use: (context: C) => Promise<T>,
  options: FreshProfileOptions = {},
): Promise<T> {
  const copy = (options.copy ?? copyProfile)(template, options.parent ?? dirname(template));
  let context: C | undefined;
  let outcome:
    | { readonly passed: true; readonly value: T }
    | { readonly passed: false; readonly error: unknown };
  try {
    context = await launch(copy.directory);
    outcome = { passed: true, value: await use(context) };
  } catch (error) {
    outcome = { passed: false, error };
  }

  const teardown: unknown[] = [];
  try {
    await context?.close();
  } catch (error) {
    teardown.push(error);
  }
  try {
    copy.remove();
  } catch (error) {
    teardown.push(error);
  }

  if (!outcome.passed) {
    if (teardown.length > 0) {
      (options.report ?? toStandardError)(new ProfileTeardownError(teardown).message);
    }
    throw outcome.error;
  }
  if (teardown.length > 0) throw new ProfileTeardownError(teardown);
  return outcome.value;
}
