/**
 * Names the revision the migration guard holds the migrations to, on a push (run 6, Stage 1.3). It is a step of the `static` job of CI, before the guard
 * (`scripts/migration-immutability.ts`), and writes `MELARC_MIGRATION_BASE=<revision>` to the file that sets the environment of the steps after it.
 *
 * Why a push needs it. A push to main tests the commit main is now at, and a guard with no base compares that commit with the merge base of itself and `origin/main`, which is
 * itself: it passes whatever was changed. What a push may have changed is what main held before it, `github.event.before`, so that is the base. A step that is deleted, or moved
 * after the guard, leaves that comparison silently empty; `scripts/ci-workflow.ts` holds the step and its place (`MIGRATION_BASE_STEP`).
 *
 *   EVENT=push BEFORE=<revision> FORCED=<true|false> GH_TOKEN=<the job's token> GITHUB_ENV=<file> node scripts/ci-migration-base.ts
 *
 *   exit 0   the base was named (written to GITHUB_ENV), or there is nothing to name: the run is not a push
 *   exit 1   the push came from a revision this checkout does not have and it could not be fetched; or BEFORE is empty, is not a revision, or is all zeros
 *            (the push created main: see below); or there is no GITHUB_ENV to write to
 *
 * A **force push** replaces the history of main: the commit `before` names is no longer reachable from any branch, and the checkout (the whole history of the new main) does not hold
 * it. The commit may still be on the server, so it is fetched by name; if it cannot be, the run fails, in words that name the force push. **It never falls back to `origin/main`**: on
 * a push that is the revision under test, and the comparison would pass whatever was changed. Branch protection should refuse a force push to main in the first place.
 *
 * **The fetch is made with the job's token** (run 7, Stage 3.4). The job checks out with `persist-credentials: false`, so a fetch that carried nothing was anonymous and, in a private
 * repository, always failed, and the run then said that the server "no longer serves" a commit it had refused to serve to nobody. The token reaches this one fetch only, through the
 * step's `GH_TOKEN`, as an `http.extraheader` passed with `-c` on the command line (`fetchCommand`): it is not written to the checkout's configuration and not put in the URL, and it
 * is not printed. When the fetch fails, git's own error is told with every credential removed (`redacted`), and the commit "could not be fetched".
 *
 * **A push whose previous revision is all zeros created main** (run 7, Stage 3.3): the workflow runs on a push to main only, so main was deleted and created again (or this is
 * the first push of a repository), and there is no earlier tip to hold the migrations to. That used to be "nothing to name", and the guard then compared the new main with itself and
 * passed a deleted and recreated main with an edited migration in it. It fails now, in words that name the recreation.
 *
 * It uses only Node's own modules, so that CI can run it before any install.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ZERO_REVISION = /^0{40}(?:0{24})?$/;
/** A full revision: 40 hexadecimal digits (SHA-1) or 64 (SHA-256), lower case, as GitHub writes `github.event.before`. */
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What a run knows, from the environment of the step: `${{ github.event_name }}`, `${{ github.event.before }}` and `${{ github.event.forced }}`. */
export interface BaseInput {
  readonly event: string | undefined;
  readonly before: string | undefined;
  readonly forced: string | undefined;
}

/** What an attempt to fetch a commit by name came to: it did, or it did not and git said why (with every credential removed). */
export type FetchResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The part of Git the decision needs: whether the checkout has a commit, and an attempt to fetch one by name. */
export interface Repository {
  has(revision: string): boolean;
  fetch(revision: string): FetchResult;
}

export type BaseDecision =
  /** Nothing is to be named; the guard compares with the merge base of the revision and main, as it does outside CI. */
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'named'; readonly base: string; readonly fetched: boolean }
  | { readonly kind: 'fail'; readonly message: string };

/** What a push to main is held to, from the event it carries; pure but for the two questions it asks of the repository. */
export function decideBase(input: BaseInput, repository: Repository): BaseDecision {
  if (input.event !== 'push') {
    return {
      kind: 'none',
      why: `the run is not a push (${input.event ?? 'no event'}): the migrations are held to the merge base of the revision and main`,
    };
  }
  const before = (input.before ?? '').trim();
  if (before === '') {
    return {
      kind: 'fail',
      message:
        'The push names no previous revision: BEFORE (github.event.before) is empty, a variable that was not filled in. Without it the migration guard would compare the revision with itself and pass whatever was changed.',
    };
  }
  if (ZERO_REVISION.test(before)) {
    return {
      kind: 'fail',
      message:
        'This push created main (its previous revision is all zeros): main was deleted and created again, so there is no earlier tip to hold the migrations to, and a guard with no base compares the revision with itself and passes whatever was changed, an edited migration included. The migration guard does not fall back to origin/main. Restore main to the commit it had and push again; the branch protection of main should refuse deleting it. If this is the very first push of a new repository, there is nothing to hold the migrations to: run this workflow by hand instead.',
    };
  }
  if (!REVISION.test(before)) {
    return {
      kind: 'fail',
      message: `BEFORE (github.event.before) is not a full revision (40 or 64 lower-case hexadecimal digits), and the migration guard will not be held to it: ${JSON.stringify(before.slice(0, 80))}.`,
    };
  }
  if (repository.has(before)) return { kind: 'named', base: before, fetched: false };

  // The checkout has the whole history of the new main, which does not hold a commit that a force push replaced: it may still be on the server, by name.
  const attempt = repository.fetch(before);
  if (repository.has(before)) return { kind: 'named', base: before, fetched: true };

  const short = before.slice(0, 12);
  const said = attempt.ok
    ? 'git reported no error, and the commit is still not in the checkout'
    : `git said: ${attempt.error === '' ? '(nothing)' : attempt.error}`;
  const never =
    'The migration guard does not fall back to origin/main: on a push that is the revision under test, and comparing it with itself passes whatever was changed.';
  if (input.forced === 'true') {
    return {
      kind: 'fail',
      message: `This push was a force push (github.event.forced is true): it replaced the history of main, and the commit it replaced, ${short}, is not in this checkout and could not be fetched (git fetch origin ${before}; ${said}), so the migration guard cannot tell which migrations main held before the push. ${never} Restore main to the commit it replaced and push again without force; the branch protection of main should refuse a force push.`,
    };
  }
  return {
    kind: 'fail',
    message: `The commit this push came from, ${short}, is not in this checkout and could not be fetched (git fetch origin ${before}; ${said}), so the migration guard cannot tell which migrations main held before the push. ${never} Check that the checkout fetched the whole history (fetch-depth: 0).`,
  };
}

/** The arguments of the one fetch, and the secrets that must never be printed because the arguments hold them (or their encoding). */
export function fetchCommand(
  revision: string,
  token: string | undefined,
): { readonly args: readonly string[]; readonly secrets: readonly string[] } {
  // `--` keeps the revision from ever being read as an option.
  const fetch = ['fetch', '--no-tags', '--quiet', 'origin', '--', revision];
  const given = (token ?? '').trim();
  if (given === '') return { args: fetch, secrets: [] };
  // As `actions/checkout` sends its token: basic, for the user `x-access-token`. Passed on the command line with `-c`: it applies to this command alone and is written nowhere.
  const encoded = Buffer.from(`x-access-token:${given}`).toString('base64');
  return {
    args: ['-c', `http.extraheader=AUTHORIZATION: basic ${encoded}`, ...fetch],
    secrets: [given, encoded],
  };
}

/** What git said, with every credential removed: the secrets given, an `Authorization` header whatever its scheme, and the user and password of a URL. */
export function redacted(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) if (secret !== '') clean = clean.split(secret).join('***');
  return clean
    .replaceAll(/(authorization:\s*)(?:basic|bearer|token)\s+\S+/gi, '$1***')
    .replaceAll(/(\/\/)[^/@\s]+@/g, '$1***@');
}

/** How much of git's answer a failure repeats: its last lines, which are where it says what went wrong. */
const ERROR_LINES = 6;

/** A fetch that failed, as the step tells it: the end of what git printed, one line, with every credential removed first. */
export function fetchFailure(
  ran: { readonly stderr: string; readonly stdout: string; readonly error?: Error | undefined },
  secrets: readonly string[],
): { readonly ok: false; readonly error: string } {
  const said = `${ran.stderr}${ran.stdout}${ran.error === undefined ? '' : ran.error.message}`;
  const lines = redacted(said, secrets)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return { ok: false, error: lines.slice(-ERROR_LINES).join(' | ') };
}

/** Git as the step has it: the checkout of the run is the current directory, and `token` is the job's, for the fetch alone. */
function gitRepository(cwd: string, token: string | undefined): Repository {
  return {
    has: (revision) =>
      spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd, stdio: 'ignore' })
        .status === 0,
    fetch: (revision) => {
      const command = fetchCommand(revision, token);
      const ran = spawnSync('git', [...command.args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (ran.status === 0) return { ok: true };
      // A failure is an answer, not an error: the commit is then still missing, and the decision says so, with what git said.
      return fetchFailure(ran, command.secrets);
    },
  };
}

/** Runs the step: the decision for the environment given, the line written to the file that sets the environment of the later steps, and the exit code. */
export function run(
  environment: NodeJS.ProcessEnv,
  repository: Repository,
  say: (line: string) => void,
  complain: (line: string) => void,
): number {
  const decision = decideBase(
    { event: environment.EVENT, before: environment.BEFORE, forced: environment.FORCED },
    repository,
  );
  if (decision.kind === 'none') {
    say(`No migration base is named: ${decision.why}.`);
    return 0;
  }
  if (decision.kind === 'fail') {
    complain(`The migrations were not held to a base: ${decision.message}`);
    return 1;
  }
  const file = environment.GITHUB_ENV;
  if (file === undefined || file === '') {
    complain(
      'GITHUB_ENV is not set: there is no file to name the base in, and the migration guard would compare the revision with itself.',
    );
    return 1;
  }
  appendFileSync(file, `MELARC_MIGRATION_BASE=${decision.base}\n`);
  say(
    `The migrations are held to ${decision.base.slice(0, 12)}, the revision this push came from${decision.fetched ? ' (fetched by name: it is not in the history of the new main)' : ''}.`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = run(
    process.env,
    gitRepository(process.cwd(), process.env.GH_TOKEN),
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
}
