import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  decideBase,
  fetchCommand,
  redacted,
  type FetchResult,
  type Repository,
  fetchFailure,
} from './ci-migration-base.ts';
import { MIGRATIONS_DIRECTORY } from './migration-immutability.ts';

/**
 * The step that names the revision a push to main is held to (run 6, Stage 1.3). A push tests the commit main is now at, and a guard with no base compares it with the merge
 * base of itself and origin/main, which is itself: so the base is the revision the push came from, and a force push, which replaces the history of main, may leave that
 * revision out of the checkout.
 */
const SCRIPT = resolve(import.meta.dirname, 'ci-migration-base.ts');
const GUARD = resolve(import.meta.dirname, 'migration-immutability.ts');
const MIGRATION = `${MIGRATIONS_DIRECTORY}/0000_foundation.sql`;
const SOMEWHERE_ELSE = 'f'.repeat(40);

describe('what a push is held to, decided from the event', () => {
  /** A repository that has the revisions given, and is able to fetch the others given; it keeps the fetches it was asked for. */
  function repository(
    has: readonly string[],
    fetchable: readonly string[] = [],
  ): { repository: Repository; fetched: string[] } {
    const present = new Set(has);
    const fetched: string[] = [];
    return {
      fetched,
      repository: {
        has: (revision) => present.has(revision),
        fetch: (revision): FetchResult => {
          fetched.push(revision);
          if (!fetchable.includes(revision)) return { ok: false, error: GIT_SAID };
          present.add(revision);
          return { ok: true };
        },
      },
    };
  }
  const BEFORE = 'a'.repeat(40);
  const GIT_SAID =
    "fatal: unable to access 'https://github.com/example/repo/': The requested URL returned error: 404";

  it('names the revision a push came from when the checkout has it, and fetches nothing', () => {
    const { repository: git, fetched } = repository([BEFORE]);

    assert.deepEqual(decideBase({ event: 'push', before: BEFORE, forced: 'false' }, git), {
      kind: 'named',
      base: BEFORE,
      fetched: false,
    });
    assert.deepEqual(fetched, []);
  });

  // Break caught: a base named on a run that has no previous revision (a pull request, the nightly run, a manual run), which would hold it to a revision that means nothing.
  for (const event of ['pull_request', 'schedule', 'workflow_dispatch', undefined]) {
    it(`names nothing on a run that is not a push (${String(event)})`, () => {
      const { repository: git } = repository([BEFORE]);

      assert.equal(decideBase({ event, before: BEFORE, forced: 'false' }, git).kind, 'none');
    });
  }

  // Break caught (run 7, Stage 3.3): the all-zero previous revision of a push to main read as "nothing to name". It is main created: deleted and created again, with whatever history
  // the pusher chose, and the guard that was named no base compared that history with itself and passed an edited migration. The push fails, in words that name the recreation.
  for (const forced of ['false', 'true', undefined]) {
    it(`fails when a push created main: its previous revision is all zeros (forced: ${String(forced)})`, () => {
      const { repository: git, fetched } = repository([]);

      const decision = decideBase({ event: 'push', before: '0'.repeat(40), forced }, git);

      assert.ok(decision.kind === 'fail');
      assert.match(
        decision.message,
        /^This push created main \(its previous revision is all zeros\)/,
      );
      assert.match(decision.message, /deleted and created again/);
      assert.match(decision.message, /does not fall back to origin\/main/);
      assert.deepEqual(fetched, []);
    });
  }

  // Break caught: an empty BEFORE on a push read as "none", which is the guard comparing the revision with itself and passing whatever was changed.
  for (const before of [undefined, '', '   ']) {
    it(`fails on a push whose previous revision is ${JSON.stringify(before)}`, () => {
      const decision = decideBase(
        { event: 'push', before, forced: 'false' },
        repository([]).repository,
      );

      assert.ok(decision.kind === 'fail');
      assert.match(decision.message, /not filled in|names no previous revision/);
    });
  }

  // Break caught: a value that is not a revision reaching Git (an option, a name, a short or upper-case digest).
  for (const before of [
    '--upload-pack=evil',
    'main',
    'abc123',
    'A'.repeat(40),
    `${'a'.repeat(39)}g`,
    'a'.repeat(41),
  ]) {
    it(`fails, and asks Git nothing, for ${JSON.stringify(before)}`, () => {
      const { repository: git, fetched } = repository([before]);

      const decision = decideBase({ event: 'push', before, forced: 'false' }, git);

      assert.equal(decision.kind, 'fail');
      assert.deepEqual(fetched, []);
    });
  }

  it('fetches a revision the checkout lacks, by name, and names it once it has come', () => {
    const { repository: git, fetched } = repository([], [BEFORE]);

    assert.deepEqual(decideBase({ event: 'push', before: BEFORE, forced: 'true' }, git), {
      kind: 'named',
      base: BEFORE,
      fetched: true,
    });
    assert.deepEqual(fetched, [BEFORE]);
  });

  // Break caught: a force push whose replaced revision is gone, passed (the guard compared the revision with itself) or failed in words that do not say what happened.
  it('fails when a force push replaced a revision that cannot be fetched, and says so: the force push, the revision, and that origin/main is not the fallback', () => {
    const { repository: git, fetched } = repository([]);

    const decision = decideBase({ event: 'push', before: BEFORE, forced: 'true' }, git);

    assert.ok(decision.kind === 'fail');
    const { message } = decision;
    // It says what happened to the push, in its first words: that it was a force push. (A mention of a force push further on, in what to do, is not that.)
    assert.match(message, /^This push was a force push \(github\.event\.forced is true\)/);
    assert.ok(message.includes(BEFORE.slice(0, 12)), message);
    assert.match(message, /does not fall back to origin\/main/);
    assert.deepEqual(fetched, [BEFORE], 'it tried to fetch it, once, before it gave up');
  });

  // Break caught (run 7, Stage 3.4): the failure of the fetch told as a fact about the server ("no longer serves it") when the fetch was anonymous and failed for want of a token, and git's
  // own error thrown away. A fetch that failed is told as one that could not be fetched, with what git said, so that a private repository's refusal is not read as a commit that is gone.
  for (const forced of ['true', 'false']) {
    it(`says the commit could not be fetched, with what git said, and not that the server no longer serves it (forced: ${forced})`, () => {
      const { repository: git } = repository([]);

      const decision = decideBase({ event: 'push', before: BEFORE, forced }, git);

      assert.ok(decision.kind === 'fail');
      assert.match(decision.message, /could not be fetched/);
      assert.ok(decision.message.includes(GIT_SAID), decision.message);
      assert.doesNotMatch(decision.message, /no longer serves it|did not bring it/);
    });
  }

  it('fails in its own words when a push that was not forced came from a revision the checkout lacks', () => {
    const { repository: git } = repository([]);

    const decision = decideBase({ event: 'push', before: BEFORE, forced: 'false' }, git);

    assert.ok(decision.kind === 'fail');
    const { message } = decision;
    assert.doesNotMatch(message, /force push/);
    assert.match(message, /fetch-depth: 0/);
    assert.match(message, /does not fall back to origin\/main/);
  });
});

/** A token as GitHub hands a job one; nothing of it may reach a log, a file or an error. */
const TOKEN = 'ghs_Z7qXr0kLmN3pVw9Yb2TdE5fHaJ8cU1iO4sG6';
const HEADER_VALUE = `basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

describe('the fetch of a replaced commit', () => {
  // Break caught (run 7, Stage 3.4): an anonymous fetch (the job checks out with persist-credentials: false), which in a private repository always fails. The token goes to this
  // one fetch as an extra header passed on the command line, scoped to the command: it is not a `git config` and it is not in the URL.
  it('hands the job token to the one fetch as an http.extraheader passed with -c, and writes it nowhere', () => {
    const command = fetchCommand('b'.repeat(40), TOKEN);

    assert.deepEqual(command.args, [
      '-c',
      `http.extraheader=AUTHORIZATION: ${HEADER_VALUE}`,
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      '--',
      'b'.repeat(40),
    ]);
    assert.ok(!command.args.includes('config'));
    assert.ok(!command.args.some((argument) => argument.includes(TOKEN)));
    assert.deepEqual(
      [...command.secrets].sort(),
      [HEADER_VALUE.slice('basic '.length), TOKEN].sort(),
    );
  });

  it('fetches anonymously, as before, when the step has no token', () => {
    for (const token of [undefined, '', '  ']) {
      const command = fetchCommand('b'.repeat(40), token);

      assert.deepEqual(command.args, [
        'fetch',
        '--no-tags',
        '--quiet',
        'origin',
        '--',
        'b'.repeat(40),
      ]);
      assert.deepEqual(command.secrets, []);
    }
  });

  // Break caught: git's error printed as it came, with a credential in it (a trace of the requests, a URL with a user in it).
  it('removes every credential from what git said, whatever form it is in', () => {
    const base64 = HEADER_VALUE.slice('basic '.length);
    const said = [
      `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/example/repo/': 403`,
      `=> Send header: Authorization: ${HEADER_VALUE}`,
      `authorization: Bearer ${TOKEN}`,
      `the token ${TOKEN} and its base64 ${base64} again ${TOKEN}`,
      "fatal: unable to access 'https://user:secret@example.com/r.git/': nope",
    ].join('\n');

    const clean = redacted(said, [TOKEN, base64]);

    assert.ok(!clean.includes(TOKEN), clean);
    assert.ok(!clean.includes(base64), clean);
    assert.ok(!clean.includes('secret@'), clean);
    assert.doesNotMatch(clean, /Authorization: (?:basic|bearer) \S/i);
    assert.match(clean, /fatal: unable to access/);
    assert.match(clean, /403/);
  });

  // Break caught: the failure told with git's output as it came. A fetch that is traced or run verbosely ends with the headers it sent, and the end of its output is what a failure repeats.
  it('tells a failed fetch from the end of what git printed, with the credentials removed from those lines', () => {
    const base64 = HEADER_VALUE.slice('basic '.length);
    const ran = {
      stdout: '',
      stderr: [
        'first line of a long trace',
        ...Array.from({ length: 6 }, (_, index) => `trace line ${String(index)}`),
        `=> Send header: Authorization: ${HEADER_VALUE}`,
        `  -c http.extraheader=AUTHORIZATION: ${HEADER_VALUE}`,
        `remote: Invalid username or token ${TOKEN}`,
        'fatal: unable to access the repository: The requested URL returned error: 403',
      ].join('\n'),
    };

    const failure = fetchFailure(ran, [TOKEN, base64]);

    assert.equal(failure.ok, false);
    assert.ok(!failure.error.includes(TOKEN), failure.error);
    assert.ok(!failure.error.includes(base64), failure.error);
    assert.match(failure.error, /returned error: 403/);
    assert.match(failure.error, /Invalid username or token/);
    assert.ok(!failure.error.includes('first line'), 'only the end of it is repeated');
  });

  it('leaves a message with no credential in it as it was', () => {
    const said = "fatal: couldn't find remote ref bbbbbbbb";

    assert.equal(redacted(said, [TOKEN]), said);
  });
});

describe('the step, run as CI runs it, on real repositories', () => {
  const created: string[] = [];
  after(() => {
    for (const directory of created) rmSync(directory, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  function write(root: string, path: string, content: string): void {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  function scratch(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    created.push(directory);
    return directory;
  }
  function configure(root: string): void {
    git(root, 'config', 'user.email', 'ci@example.invalid');
    git(root, 'config', 'user.name', 'CI test');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'config', 'commit.gpgsign', 'false');
  }

  /**
   * A server (`origin`, bare, which serves any commit it holds by name) and the checkout of a run: the whole history of main, and nothing else. `before` is the tip main had
   * before the push, `after` the tip it has now (it edits a migration main already had); `replaced` is a commit only the server holds (the one a force push replaced).
   */
  function world(): {
    origin: string;
    checkout: string;
    before: string;
    after: string;
    replaced: string;
  } {
    const origin = scratch('melarc-base-origin-');
    git(origin, 'init', '--quiet', '--bare');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const work = scratch('melarc-base-work-');
    git(work, 'init', '--quiet');
    configure(work);
    git(work, 'branch', '-M', 'main');
    // As the repository has it: the working copy's line endings are not what the guard compares (a checkout on Windows may write CRLF).
    write(work, '.gitattributes', '* text=auto eol=lf\n');
    write(work, MIGRATION, 'create table a ();\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'main before the push');
    const before = git(work, 'rev-parse', 'HEAD');
    write(work, MIGRATION, 'create table a (id int);\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'the push edits a migration main had');
    const after = git(work, 'rev-parse', 'HEAD');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '--quiet', 'origin', 'main');
    // The commit a force push replaced: on the server, in no branch the checkout fetched.
    git(work, 'checkout', '--quiet', '-b', 'replaced', before);
    write(work, 'replaced.txt', 'the history main had before it was replaced\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'the replaced tip');
    const replaced = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '--quiet', 'origin', 'replaced');
    git(work, 'push', '--quiet', 'origin', `:replaced`);

    const checkout = scratch('melarc-base-checkout-');
    // `--no-local`: a clone of a path copies every object of the source, the unreachable ones too, and the checkout of a run holds what a fetch brings.
    git(
      checkout,
      '-c',
      'core.autocrlf=false',
      'clone',
      '--quiet',
      '--no-local',
      '--single-branch',
      '--branch',
      'main',
      '--no-tags',
      origin,
      '.',
    );
    configure(checkout);
    return { origin, checkout, before, after, replaced };
  }

  /** Runs the step in `cwd` with the event it is given; `GITHUB_ENV` is a file of its own, whose content is what the later steps would get. */
  function step(
    cwd: string,
    event: { EVENT?: string; BEFORE?: string; FORCED?: string },
    options: { withEnvFile?: boolean } = {},
  ): { status: number | null; stdout: string; stderr: string; environment: string } {
    const file = join(scratch('melarc-base-env-'), 'github_env');
    writeFileSync(file, '');
    const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const key of ['EVENT', 'BEFORE', 'FORCED', 'GITHUB_ENV', 'MELARC_MIGRATION_BASE']) {
      Reflect.deleteProperty(environment, key);
    }
    Object.assign(environment, event, options.withEnvFile === false ? {} : { GITHUB_ENV: file });
    const run = spawnSync(process.execPath, [SCRIPT], { cwd, env: environment, encoding: 'utf8' });
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      environment: readFileSync(file, 'utf8'),
    };
  }

  it('writes the revision the push came from to the environment of the later steps', () => {
    const { checkout, before } = world();

    const ran = step(checkout, { EVENT: 'push', BEFORE: before, FORCED: 'false' });

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.environment, `MELARC_MIGRATION_BASE=${before}\n`);
  });

  it('writes nothing on a pull request', () => {
    const { checkout, before } = world();

    const ran = step(checkout, { EVENT: 'pull_request', BEFORE: before, FORCED: 'false' });

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.environment, '');
  });

  // Break caught: a force push whose replaced revision is still on the server, failed for want of a fetch: it is fetched by name, and then it is the base.
  it('fetches the revision a force push replaced when the server still has it, and names it', () => {
    const { checkout, replaced } = world();
    assert.throws(
      () => git(checkout, 'cat-file', '-e', `${replaced}^{commit}`),
      'the checkout lacks it',
    );

    const ran = step(checkout, { EVENT: 'push', BEFORE: replaced, FORCED: 'true' });

    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.environment, `MELARC_MIGRATION_BASE=${replaced}\n`);
    assert.equal(git(checkout, 'cat-file', '-t', replaced), 'commit');
  });

  // Break caught (run 7, Stage 3.4): the fetch of a replaced commit made without the job's token, or with it written to the checkout's configuration, or printed. Here `origin` is a
  // server that refuses (403) and records the header it was sent, and git is made to trace every header unredacted (GIT_TRACE_CURL, GIT_TRACE_REDACT=0) so that a step that printed what
  // git said without removing the credential would show it. The header arrives, the failure is told as a fetch that could not be made, with git's own words, and the token is in no
  // line of the output and in no file of the checkout.
  it('fetches with the job token, tells a refusal as "could not be fetched" and leaks the token nowhere', async () => {
    const { checkout } = world();
    const seen: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.statusCode = 403;
      response.end('refused');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as AddressInfo;
      git(checkout, 'remote', 'set-url', 'origin', `http://127.0.0.1:${String(port)}/private.git`);
      const file = join(scratch('melarc-base-env-'), 'github_env');
      writeFileSync(file, '');
      const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      for (const key of ['BEFORE', 'GITHUB_ENV', 'MELARC_MIGRATION_BASE', 'GH_TOKEN']) {
        Reflect.deleteProperty(environment, key);
      }
      Object.assign(environment, {
        EVENT: 'push',
        BEFORE: SOMEWHERE_ELSE,
        FORCED: 'true',
        GITHUB_ENV: file,
        GH_TOKEN: TOKEN,
        GIT_TRACE_CURL: '1',
        GIT_TRACE_REDACT: '0',
      });
      const child = spawn(process.execPath, [SCRIPT], { cwd: checkout, env: environment });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => void (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => void (output += chunk.toString()));
      const status = await new Promise<number | null>((done) => child.on('close', done));

      assert.equal(status, 1, output);
      assert.ok(seen.length > 0, 'the server was asked');
      assert.equal(seen[0], HEADER_VALUE, 'the first request carried the job token');
      assert.match(output, /could not be fetched/);
      assert.match(output, /403/, "git's own words are there");
      assert.ok(!output.includes(TOKEN), 'the token is not printed');
      assert.ok(!output.includes(HEADER_VALUE.slice('basic '.length)), 'its base64 is not printed');
      assert.equal(readFileSync(file, 'utf8'), '');
      const configuration = readFileSync(join(checkout, '.git', 'config'), 'utf8');
      assert.ok(!configuration.includes(TOKEN) && !/extraheader/i.test(configuration));
    } finally {
      server.close();
    }
  });

  // Break caught: a force push whose replaced revision is gone, ended with success or with a fall back to origin/main: nothing is written, and the words name the force push.
  it('fails, names the force push and writes nothing when the replaced revision is nowhere', () => {
    const { checkout } = world();

    const ran = step(checkout, { EVENT: 'push', BEFORE: SOMEWHERE_ELSE, FORCED: 'true' });

    assert.equal(ran.status, 1);
    assert.match(
      ran.stderr,
      /The migrations were not held to a base: This push was a force push \(github\.event\.forced is true\)/,
    );
    assert.match(ran.stderr, /does not fall back to origin\/main/);
    assert.equal(ran.environment, '');
  });

  // Break caught (run 7, Stage 3.3): main deleted and created again, and the push that created it passed with an edited migration: nothing is written, the words name the recreation.
  it('fails, names the recreation and writes nothing when the push created main', () => {
    const { checkout } = world();

    const ran = step(checkout, { EVENT: 'push', BEFORE: '0'.repeat(40), FORCED: 'false' });

    assert.equal(ran.status, 1);
    assert.match(
      ran.stderr,
      /The migrations were not held to a base: This push created main \(its previous revision is all zeros\)/,
    );
    assert.match(ran.stderr, /deleted and created again/);
    assert.equal(ran.environment, '');
  });

  it('fails when there is no file to write the base to', () => {
    const { checkout, before } = world();

    const ran = step(
      checkout,
      { EVENT: 'push', BEFORE: before, FORCED: 'false' },
      { withEnvFile: false },
    );

    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /GITHUB_ENV is not set/);
  });

  // Break caught (the point of the step): a push to main that edits a migration main had passes the guard when the step is missing, because the guard then compares the
  // revision with itself, and fails it when the step has named the revision the push came from.
  it('is what makes the guard see a migration that a push edited: without it the guard passes the same tree', () => {
    const { checkout, before, after } = world();
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), after);
    const guard = (base: string | undefined) => {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      Reflect.deleteProperty(environment, 'MELARC_MIGRATION_BASE');
      if (base !== undefined) environment.MELARC_MIGRATION_BASE = base;
      return spawnSync(process.execPath, [GUARD], {
        cwd: checkout,
        env: environment,
        encoding: 'utf8',
      });
    };

    const without = guard(undefined);
    assert.equal(without.status, 0, without.stdout + without.stderr);

    const named = step(checkout, { EVENT: 'push', BEFORE: before, FORCED: 'false' });
    const base = /^MELARC_MIGRATION_BASE=(.+)$/m.exec(named.environment)?.[1];
    assert.equal(base, before);
    const held = guard(base);
    assert.equal(held.status, 1, held.stdout + held.stderr);
    assert.match(held.stderr, /0000_foundation\.sql is changed, and main has it/);
  });
});
