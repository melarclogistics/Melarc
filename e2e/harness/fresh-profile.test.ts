import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyProfile, ProfileTeardownError, withFreshProfile } from './fresh-profile.ts';

/**
 * The per-test copy of a Firefox profile (the review of 12 October 2026, F04), on a fake profile: no browser is started, so what is
 * shown is that no context is launched from the template, that what one test writes is gone in the next, and that the copy is removed
 * however the test ended. That the real Firefox then keeps the CA and nothing else is `tests/https-isolation.spec.ts`, in the run in a
 * clean environment.
 */
let base: string;
let template: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'melarc-profile-'));
  template = join(base, 'firefox-profile');
  mkdirSync(template);
  writeFileSync(join(template, 'cert9.db'), 'the certificate database holding the test CA');
  mkdirSync(join(template, 'storage'));
  writeFileSync(join(template, 'storage', 'marker'), 'seeded');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const entries = (directory: string): string[] => readdirSync(directory).toSorted();

describe('copyProfile', () => {
  // Break caught: the copy missing what makes the engine trust the CA, or what the template holds besides.
  it('copies the whole template, the certificate database included', () => {
    const copy = copyProfile(template);

    expect(entries(copy.directory)).toEqual(['cert9.db', 'storage']);
    expect(readFileSync(join(copy.directory, 'cert9.db'), 'utf8')).toBe(
      'the certificate database holding the test CA',
    );
    expect(readFileSync(join(copy.directory, 'storage', 'marker'), 'utf8')).toBe('seeded');
  });

  // Break caught: the copy being the template (a rename, a link, the same directory returned): what a test writes would stay in the
  // seed for every later test.
  it('is a directory of its own, beside the template, and a change in it leaves the template as it was', () => {
    const copy = copyProfile(template);
    writeFileSync(join(copy.directory, 'cookies.sqlite'), 'a cookie written by one test');
    writeFileSync(join(copy.directory, 'storage', 'marker'), 'changed');

    expect(copy.directory).not.toBe(template);
    expect(entries(base)).toContain('firefox-profile');
    expect(entries(template)).toEqual(['cert9.db', 'storage']);
    expect(readFileSync(join(template, 'storage', 'marker'), 'utf8')).toBe('seeded');
  });

  // Break caught: two tests given one directory, so that the second starts with what the first wrote.
  it('gives every call a directory of its own, each starting from the template', () => {
    const first = copyProfile(template);
    writeFileSync(join(first.directory, 'cookies.sqlite'), 'written by the first');
    const second = copyProfile(template);

    expect(second.directory).not.toBe(first.directory);
    expect(entries(second.directory)).toEqual(['cert9.db', 'storage']);
  });

  // Break caught: a copy left behind, which would fill the run's directory and carry state if its name were ever reused.
  it('removes the copy and only the copy, and may be removed twice', () => {
    const copy = copyProfile(template);

    copy.remove();
    copy.remove();

    expect(existsSync(copy.directory)).toBe(false);
    expect(existsSync(template)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('makes the copy private to its owner', () => {
    expect(statSync(copyProfile(template).directory).mode & 0o777).toBe(0o700);
  });

  // Break caught: a template that is not there copied as an empty profile, which would launch a browser that trusts nothing and fail
  // far from the cause.
  it('refuses a template that does not exist', () => {
    expect(() => copyProfile(join(base, 'no-such-profile'))).toThrow(/not a directory/);
  });

  // Break caught: a copy made inside the template, which a recursive copy would follow for ever.
  it('refuses to copy a profile into itself', () => {
    expect(() => copyProfile(template, template)).toThrow(/never into it/);
    expect(() => copyProfile(template, join(template, 'storage'))).toThrow(/never into it/);
  });
});

describe('withFreshProfile', () => {
  const launcher = () => {
    const launched: string[] = [];
    const closed: string[] = [];
    return {
      launched,
      closed,
      launch: (directory: string) => {
        launched.push(directory);
        return Promise.resolve({
          directory,
          close: () => {
            closed.push(directory);
            return Promise.resolve();
          },
        });
      },
    };
  };

  // Break caught (F04): a context launched from the shared profile. The template is never what a browser runs from, and the directory
  // that it is launched from exists while the test uses it.
  it('launches from a copy, never from the template, and the copy exists while the test uses it', async () => {
    const { launch, launched } = launcher();
    let seen = false;

    await withFreshProfile(template, launch, (context) => {
      seen = existsSync(join(context.directory, 'cert9.db'));
      return Promise.resolve();
    });

    expect(seen).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]).not.toBe(template);
  });

  // Break caught (F04, the behaviour): one test's cookie and local storage visible to the next. The first test writes into its
  // context's directory; the second is given a directory that holds the seed and not that.
  it('gives the next test a context that has neither what the last test wrote nor lost the CA', async () => {
    const { launch } = launcher();

    await withFreshProfile(template, launch, (context) => {
      writeFileSync(join(context.directory, 'cookies.sqlite'), 'persistent cookie');
      writeFileSync(join(context.directory, 'webappsstore.sqlite'), 'local storage');
      return Promise.resolve();
    });
    const next = await withFreshProfile(template, launch, (context) =>
      Promise.resolve({
        files: entries(context.directory),
        certificates: readFileSync(join(context.directory, 'cert9.db'), 'utf8'),
      }),
    );

    expect(next.files).toEqual(['cert9.db', 'storage']);
    expect(next.certificates).toBe('the certificate database holding the test CA');
  });

  // Break caught: the context left open, or the copy left on disk, after a test that finished, or one that threw.
  it('closes the context and removes the copy when the test ends, and when it throws', async () => {
    const ended = launcher();
    await withFreshProfile(template, ended.launch, () => Promise.resolve());
    const threw = launcher();
    await expect(
      withFreshProfile(template, threw.launch, () => Promise.reject(new Error('the test failed'))),
    ).rejects.toThrow('the test failed');

    for (const run of [ended, threw]) {
      expect(run.closed).toEqual(run.launched);
      expect(existsSync(run.launched[0] ?? '')).toBe(false);
    }
    expect(entries(base)).toEqual(['firefox-profile']);
  });

  // Break caught (the follow-up of the second review, 12 October 2026): a context that cannot be closed swallowed, so that a test that
  // passed is reported as passing though its teardown failed. The copy still goes, and the failure is reported.
  it('fails a test that passed when its context cannot be closed, and still removes the copy', async () => {
    const directories: string[] = [];

    const outcome = await withFreshProfile(
      template,
      (directory) => {
        directories.push(directory);
        return Promise.resolve({ close: () => Promise.reject(new Error('already gone')) });
      },
      () => Promise.resolve('the test passed'),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ProfileTeardownError);
    expect((outcome as ProfileTeardownError).message).toMatch(/already gone/);
    expect(existsSync(directories[0] ?? '')).toBe(false);
  });

  // Break caught: the failure of a test replaced by the failure of its teardown, or the teardown's lost. The test's own failure is the
  // failure, the very same error, and the teardown's is reported beside it.
  it('keeps the failure of a test that failed, and reports the failure of its teardown beside it', async () => {
    const reports: string[] = [];
    const directories: string[] = [];
    const failure = new Error('the test failed');

    const outcome = await withFreshProfile(
      template,
      (directory) => {
        directories.push(directory);
        return Promise.resolve({ close: () => Promise.reject(new Error('already gone')) });
      },
      () => Promise.reject(failure),
      {
        report: (message) => {
          reports.push(message);
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBe(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/already gone/);
    expect(existsSync(directories[0] ?? '')).toBe(false);
  });

  // Break caught: a copy that cannot be removed lost, for a test that passed and for one that failed. A copy left on disk is state that
  // the next test could meet, so it is reported like any other teardown failure.
  it('reports a copy that cannot be removed: failing a test that passed, beside the failure of one that failed', async () => {
    const stuck = () => ({
      directory: join(base, 'a-copy-that-stays'),
      remove: () => {
        throw new Error('the directory is in use');
      },
    });
    const close = () => Promise.resolve({ close: () => Promise.resolve() });
    const reports: string[] = [];
    const failure = new Error('the test failed');

    const passed = await withFreshProfile(template, close, () => Promise.resolve('passed'), {
      copy: stuck,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const failed = await withFreshProfile(template, close, () => Promise.reject(failure), {
      copy: stuck,
      report: (message) => {
        reports.push(message);
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(passed).toBeInstanceOf(ProfileTeardownError);
    expect((passed as ProfileTeardownError).message).toMatch(/the directory is in use/);
    expect(failed).toBe(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/the directory is in use/);
  });

  // Break caught: only the first failure of the teardown reported when the close and the removal both fail: neither is to be lost.
  it('reports the close and the removal together when both fail', async () => {
    const outcome = await withFreshProfile(
      template,
      () => Promise.resolve({ close: () => Promise.reject(new Error('already gone')) }),
      () => Promise.resolve('passed'),
      {
        copy: () => ({
          directory: join(base, 'a-copy-that-stays'),
          remove: () => {
            throw new Error('the directory is in use');
          },
        }),
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ProfileTeardownError);
    expect((outcome as ProfileTeardownError).failures).toHaveLength(2);
    expect((outcome as ProfileTeardownError).message).toMatch(
      /already gone.*the directory is in use/,
    );
  });

  // Break caught: a launch that fails leaving the copy behind.
  it('removes the copy when the launch fails', async () => {
    await expect(
      withFreshProfile(
        template,
        () => Promise.reject(new Error('the browser did not start')),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow('the browser did not start');

    expect(entries(base)).toEqual(['firefox-profile']);
  });
});
