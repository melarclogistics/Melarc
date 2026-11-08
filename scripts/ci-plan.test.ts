import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { decide, lastNightlySha, lastNightlyUrl, plan, type Fetcher } from './ci-plan.ts';

const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

/** A stand-in for GitHub that answers with the given body, and keeps what it was asked. */
function answering(
  body: unknown,
  status = 200,
): { fetcher: Fetcher; asked: string[]; headers: Record<string, string>[] } {
  const asked: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetcher: Fetcher = (url, init) => {
    asked.push(url);
    headers.push(init.headers);
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  };
  return { fetcher, asked, headers };
}

const runsOf = (...shas: string[]): unknown => ({
  workflow_runs: shas.map((head_sha) => ({ head_sha })),
});

describe('decide: what the plan of a run is', () => {
  // Break caught: the nightly run running again for a commit that a successful nightly run already tested, which is a night of runner minutes
  // for no new proof.
  it('stands the nightly run down when the last successful nightly run tested this very commit', () => {
    const decided = decide('schedule', HEAD, HEAD);
    assert.equal(decided.run, false);
    assert.match(decided.reason, /nothing changed/);
  });

  it('compares the commits whatever their case or the spaces around them', () => {
    assert.equal(decide('schedule', HEAD.toUpperCase(), ` ${HEAD} `).run, false);
  });

  // Break caught: a night that skips because main changed, or because it could not tell.
  it('runs the nightly run when main moved since the last successful nightly run', () => {
    assert.equal(decide('schedule', HEAD, OLDER).run, true);
  });

  it('runs the nightly run when there is no successful nightly run to compare with, or none could be read', () => {
    assert.equal(decide('schedule', HEAD, undefined).run, true);
  });

  it('runs the nightly run when the commit under test is not known', () => {
    assert.equal(decide('schedule', undefined, HEAD).run, true);
    assert.equal(decide('schedule', '  ', HEAD).run, true);
  });

  // Break caught: a push to main, a pull request or a manual run standing down because its commit equals a nightly run's: each of them is a
  // request for a verdict, and a skipped pull-request run would leave the commit with none.
  for (const event of [
    'push',
    'pull_request',
    'workflow_dispatch',
    'workflow_run',
    '',
    undefined,
  ]) {
    it(`always runs a run of the event ${JSON.stringify(event)}, even for the commit of the last nightly run`, () => {
      assert.equal(decide(event, HEAD, HEAD).run, true);
    });
  }
});

describe('lastNightlyUrl', () => {
  it('asks for the latest successful run of the nightly kind on main, of this workflow, and no more than one', () => {
    const url = new URL(lastNightlyUrl('melarclogistics/Melarc'));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/repos/melarclogistics/Melarc/actions/workflows/ci.yml/runs');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      event: 'schedule',
      status: 'success',
      branch: 'main',
      per_page: '1',
    });
  });

  it('follows the API address the runner gives, without doubling a slash', () => {
    assert.match(
      lastNightlyUrl('o/r', 'https://ghe.example/api/v3/'),
      /^https:\/\/ghe\.example\/api\/v3\/repos\/o\/r\/actions/,
    );
  });
});

describe('lastNightlySha', () => {
  it('reads the commit of the latest run and sends the token as a bearer', async () => {
    const { fetcher, asked, headers } = answering(runsOf(HEAD, OLDER));
    assert.equal(await lastNightlySha(fetcher, 'o/r', 'token-value'), HEAD);
    assert.equal(asked.length, 1);
    assert.equal(headers.at(0)?.Authorization, 'Bearer token-value');
    assert.equal(headers.at(0)?.Accept, 'application/vnd.github+json');
  });

  // Break caught: any way the question fails ending in a skipped night. Each of these is "unknown", which the plan runs on.
  const unknown: [string, () => Fetcher][] = [
    ['no run is listed', () => answering(runsOf()).fetcher],
    ['the answer is an error status', () => answering({ message: 'Forbidden' }, 403).fetcher],
    ['the answer is not JSON', () => answering('<html>').fetcher],
    ['the answer is not an object', () => answering([1, 2]).fetcher],
    ['the list is not a list', () => answering({ workflow_runs: 'x' }).fetcher],
    ['the run has no commit', () => answering({ workflow_runs: [{}] }).fetcher],
    ['the commit is not a full hash', () => answering(runsOf('abc123')).fetcher],
    ['the commit is not a string', () => answering({ workflow_runs: [{ head_sha: 7 }] }).fetcher],
    ['the request fails', () => () => Promise.reject(new Error('network down'))],
  ];
  for (const [what, make] of unknown) {
    it(`is unknown when ${what}`, async () => {
      assert.equal(await lastNightlySha(make(), 'o/r', 't'), undefined);
    });
  }

  it('does not ask without a token, or with a repository that is not owner/name', async () => {
    const { fetcher, asked } = answering(runsOf(HEAD));
    assert.equal(await lastNightlySha(fetcher, 'o/r', undefined), undefined);
    assert.equal(await lastNightlySha(fetcher, 'o/r', ''), undefined);
    assert.equal(await lastNightlySha(fetcher, undefined, 't'), undefined);
    for (const repository of ['o', 'o/r/extra', 'o/../r', 'o/r?x=1', 'o/r#frag', ' o/r']) {
      assert.equal(await lastNightlySha(fetcher, repository, 't'), undefined, repository);
    }
    assert.deepEqual(asked, []);
  });
});

describe('plan', () => {
  const nightly = {
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_SHA: HEAD,
    GITHUB_REPOSITORY: 'o/r',
    GH_TOKEN: 't',
  };

  it('stands down on the night main has not moved since the last successful nightly run, and says so', async () => {
    const lines: string[] = [];
    const decided = await plan(nightly, answering(runsOf(HEAD)).fetcher, (line) =>
      lines.push(line),
    );
    assert.equal(decided.run, false);
    assert.match(lines.join('\n'), /Plan: stand down/);
  });

  it('runs when main moved, and when GitHub cannot be asked', async () => {
    assert.equal(
      (await plan(nightly, answering(runsOf(OLDER)).fetcher, () => undefined)).run,
      true,
    );
    const failing: Fetcher = () => Promise.reject(new Error('timeout'));
    assert.equal((await plan(nightly, failing, () => undefined)).run, true);
  });

  // Break caught: a push or a pull request asking GitHub anything (a slower start of every run, and a skip that is never theirs to make).
  it('asks GitHub only for the nightly run', async () => {
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
      const { fetcher, asked } = answering(runsOf(HEAD));
      const decided = await plan(
        { ...nightly, GITHUB_EVENT_NAME: event },
        fetcher,
        () => undefined,
      );
      assert.equal(decided.run, true, event);
      assert.deepEqual(asked, [], event);
    }
  });
});

describe('the command', () => {
  const script = resolve(import.meta.dirname, 'ci-plan.ts');

  function run(env: Record<string, string>): {
    status: number | null;
    output: string;
    written: string;
  } {
    const directory = mkdtempSync(join(tmpdir(), 'ci-plan-'));
    const outputFile = join(directory, 'github-output');
    try {
      // The run's own variables are cleared: a developer's GH_TOKEN must not reach GitHub from a test.
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env, GITHUB_OUTPUT: outputFile },
      });
      let written = '';
      try {
        written = readFileSync(outputFile, 'utf8');
      } catch {
        written = '(none)';
      }
      return { status: result.status, output: `${result.stdout}${result.stderr}`, written };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('writes run=true to GITHUB_OUTPUT for a push, with no network', () => {
    const result = run({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.written, 'run=true\n');
  });

  it('writes run=true for a nightly run that cannot ask (no token), and does not fail', () => {
    const result = run({
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_SHA: HEAD,
      GITHUB_REPOSITORY: 'o/r',
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.written, 'run=true\n');
    assert.match(result.output, /Plan: run/);
  });
});
