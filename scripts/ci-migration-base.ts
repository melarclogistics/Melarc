/**
 * Names the revision the migration guard holds the migrations to, on a push (run 6, Stage 1.3). It is a step of the `static` job of CI, before the guard
 * (`scripts/migration-immutability.ts`), and writes `MELARC_MIGRATION_BASE=<revision>` to the file that sets the environment of the steps after it.
 *
 * Why a push needs it. A push to main tests the commit main is now at, and a guard with no base compares that commit with the merge base of itself and `origin/main`, which is
 * itself: it passes whatever was changed. What a push may have changed is what main held before it, `github.event.before`, so that is the base. A step that is deleted, or moved
 * after the guard, leaves that comparison silently empty; `scripts/ci-workflow.ts` holds the step and its place (`MIGRATION_BASE_STEP`).
 *
 *   EVENT=push BEFORE=<revision> FORCED=<true|false> GITHUB_ENV=<file> node scripts/ci-migration-base.ts
 *
 *   exit 0   the base was named (written to GITHUB_ENV), or there is nothing to name: the run is not a push
 *   exit 1   the push came from a revision this checkout does not have and `git fetch origin <revision>` did not bring it; or BEFORE is empty, is not a revision, or is all zeros
 *            (the push created main: see below); or there is no GITHUB_ENV to write to
 *
 * A **force push** replaces the history of main: the commit `before` names is no longer reachable from any branch, and the checkout (the whole history of the new main) does not hold
 * it. The commit may still be on the server, so it is fetched by name; if it is gone, the run fails, in words that name the force push. **It never falls back to `origin/main`**: on
 * a push that is the revision under test, and the comparison would pass whatever was changed. Branch protection should refuse a force push to main in the first place.
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

const ZERO_REVISION = /^0{40}$/;
/** A full revision: 40 hexadecimal digits (SHA-1) or 64 (SHA-256), lower case, as GitHub writes `github.event.before`. */
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What a run knows, from the environment of the step: `${{ github.event_name }}`, `${{ github.event.before }}` and `${{ github.event.forced }}`. */
export interface BaseInput {
  readonly event: string | undefined;
  readonly before: string | undefined;
  readonly forced: string | undefined;
}

/** The part of Git the decision needs: whether the checkout has a commit, and an attempt to fetch one by name. */
export interface Repository {
  has(revision: string): boolean;
  fetch(revision: string): void;
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
  repository.fetch(before);
  if (repository.has(before)) return { kind: 'named', base: before, fetched: true };

  const short = before.slice(0, 12);
  const never =
    'The migration guard does not fall back to origin/main: on a push that is the revision under test, and comparing it with itself passes whatever was changed.';
  if (input.forced === 'true') {
    return {
      kind: 'fail',
      message: `This push was a force push (github.event.forced is true): it replaced the history of main, and the commit it replaced, ${short}, is not in this checkout and the server no longer serves it (git fetch origin ${before} did not bring it), so the migration guard cannot tell which migrations main held before the push. ${never} Restore main to the commit it replaced and push again without force; the branch protection of main should refuse a force push.`,
    };
  }
  return {
    kind: 'fail',
    message: `The commit this push came from, ${short}, is not in this checkout, and git fetch origin ${before} did not bring it, so the migration guard cannot tell which migrations main held before the push. ${never} Check that the checkout fetched the whole history (fetch-depth: 0).`,
  };
}

/** Git as the step has it: the checkout of the run is the current directory. */
function gitRepository(cwd: string): Repository {
  return {
    has: (revision) =>
      spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd, stdio: 'ignore' })
        .status === 0,
    fetch: (revision) => {
      // A failure is an answer, not an error: the commit is then still missing, and the decision says so. `--` keeps the revision from ever being read as an option.
      spawnSync('git', ['fetch', '--no-tags', '--quiet', 'origin', '--', revision], {
        cwd,
        stdio: 'ignore',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
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
    gitRepository(process.cwd()),
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
}
