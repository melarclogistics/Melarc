# Developer setup

How to get Melarc running on your machine and prove it works: from a clean checkout to the API, the Ops Portal and a
PostgreSQL database running locally, with the checks passing. The commands are the same on Windows (cmd, PowerShell
or Git Bash), WSL2 and Linux. `scripts/local-setup.test.ts` fails if this page names a command, script or file that
does not exist.

When you are done you have the database on `127.0.0.1:5432`, the API on `127.0.0.1:3000` and the Ops Portal dev
server proxying `/api/v1` to it. The Ops Portal has the five pre-sign-in screens (the staff sign-in and its second step,
and the three setup pages, S0.43) and, once you are signed in, the landing and the six identity screens (S0.44): the staff
list with the approver's queue, adding a profile, one profile, resetting an authenticator, and a person's sessions. No
screen can be reached before the first sign-in (section 5). The API serves its technical probes and the operations that
`src/tools/contract/implemented-scope.ts` lists.

## Prerequisites

| You need | Version                                                          | Notes                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git      | any recent                                                       |                                                                                                                                                                                                                                   |
| Node.js  | **24.21.0**, the version in [.node-version](.node-version)       | Version managers such as fnm and nvm read that file. `pnpm install` refuses a Node outside `engines` in [package.json](package.json).                                                                                             |
| pnpm     | **11.1.3**, the `packageManager` in [package.json](package.json) | `npm install -g pnpm@11.1.3`                                                                                                                                                                                                      |
| Docker   | Docker Desktop, or Docker Engine with the Compose plugin         | Running before step 3. It only hosts the local PostgreSQL service.                                                                                                                                                                |
| JDK      | **21**, the major in [.java-version](.java-version)              | Temurin; for the verifier ([step 6](#the-attestation-verifier)) and for `pnpm run test:db`, whose attested rider enrolment test and alert rehearsal build and start it. Windows: `winget install EclipseAdoptium.Temurin.21.JDK`. |

## 1. Install dependencies

```text
pnpm install --frozen-lockfile
```

For the browser tests (step 6) install the Chromium that the pinned Playwright expects. On Linux and WSL2 add
`--with-deps` (it installs system packages with `sudo`); on Windows leave it out.

```text
pnpm --filter @melarc/e2e exec playwright install chromium
```

The browser tests run Chromium unless `MELARC_BROWSERS` names more. CI runs Chromium on every pull request, and
`chromium,firefox,webkit`, the engines of the browsers the Ops Portal supports, on every push to main, every night and every
manual run ([what runs when](#what-ci-runs-when), below). To run the three on your machine, install the other two once and name
them for the run (this is `cmd`; in a POSIX shell use `export MELARC_BROWSERS=chromium,firefox,webkit`):

```text
pnpm --filter @melarc/e2e exec playwright install firefox webkit
set MELARC_BROWSERS=chromium,firefox,webkit
pnpm run test:browser
```

One engine's whole run is longer than a CI job may last, so CI runs the browser tests as a matrix of jobs, one for each
shard of each engine: `MELARC_BROWSER_SHARD=2/9` (`current/total`, counted from 1, Playwright's `--shard`) runs the second
of nine parts of the engine's tests, and the shards of an engine together run every test of it once
([ci.yml](.github/workflows/ci.yml); `scripts/browser-shards.test.ts` proves it from Playwright's own list of the tests).
To reproduce one job of CI, name its engine and its shard, for example (the engine installed first, as above):

```text
set MELARC_BROWSERS=firefox
set MELARC_BROWSER_SHARD=2/9
pnpm run test:browser
```

The gate and the affected run never read `MELARC_BROWSER_SHARD`: they run every spec they choose whole, so a shard left in your
shell does not make a run that passes for a part of its tests.

The integrated run (`pnpm run test:e2e`) serves the Ops Portal over plain HTTP in Chromium only. The trusted HTTPS origin
the identity slice needs, with Firefox and WebKit, is `pnpm run test:e2e:https`: it makes a disposable test CA, so it runs in CI
and on a machine cleared for key material, and it refuses on this workstation (Windows has no disposable trust store for Chromium or
Edge). On a machine cleared for key material WebKit's proofs fail to trust, because WebKit's only trust is the system store, which the run
changes only on a GitHub-hosted runner. What exists, what is blocked and the steps for a clean machine are in [e2e/README.md](e2e/README.md).
It is four runs (Chromium; Firefox; WebKit's refusal; WebKit's proofs), and CI makes it as three jobs, a shard of the runs in each:
`MELARC_HTTPS_SHARD=1/3` makes Chromium's run, `2/3` Firefox's, and `3/3` WebKit's refusal and then its proofs, in that order (they
stay in one job: the refusal is a control only while the CA is not in the system store, which the proofs need it in). Without the
variable it makes all four; a value that is not a shard of the harness (`e2e/harness/https-shards.ts`) is refused before anything is made.

### In a Git worktree

A worktree (`git worktree add`) is a second working copy and gets **its own** `pnpm install --frozen-lockfile --offline`. **Never link `node_modules` into it, with a junction (`mklink /J`) or a symlink:**
removing the worktree (`git worktree remove --force`, or a plain delete) follows the link and deletes the packages of the tree it pointed at (run 3 of the redesign lost
26 packages of the main tree this way, and restored them with `pnpm install --frozen-lockfile --offline`), and pnpm 11 tries to reinstall a linked tree before `pnpm exec`
unless `npm_config_verify_deps_before_run=false`. If a junction already exists, remove it first with `cmd /c rmdir <path>`, which removes the link and nothing it points at,
and only then delete anything near it.

### What CI runs when

[ci.yml](.github/workflows/ci.yml) (the Product Owner's decisions of 7 November 2026): a **pull request** runs every job but the
Firefox and WebKit shards of the browser tests, which is the Chromium shards, the HTTPS journeys in all three shards and every other
check, and it leaves out of the database tests the files whose assertions are wall-clock time and nothing else of the tests
([apps/api/test/timing-sensitive-tests.ts](apps/api/test/timing-sensitive-tests.ts): `MELARC_SKIP_TIMING_TESTS=1`, set by the
database step of a pull request and of a push to main, which run every other test; the nightly run and a manual run run those files too);
a **push to main**, the **nightly run** (02:17 UTC, Monday to Friday) and a **manual run** run all of the rest, so Firefox and WebKit are tested on every commit that reaches main and every weekday night. A first job, `plan`
([scripts/ci-plan.ts](scripts/ci-plan.ts)), lets the nightly run stand down: when the last successful nightly run tested the commit
main is at, every other job but the dependency audit is skipped and the run is a success (a push, a pull request and a manual run are
never skipped, and the plan answers "run" whenever it cannot tell; the audit is not the plan's to decide, because an advisory is published
with no commit, so it runs every night). "CI result" accepts two skips and no other: the Firefox and WebKit job's on a pull
request, and every job's but the audit's on a nightly run whose plan said so. The browser tests of each engine, the HTTPS journeys and the database
tests are cut into shards that are jobs of their own, and the shards together run every test once (`scripts/browser-shards.test.ts`
proves it for the browser tests from Playwright's own list of them, `scripts/db-shards.test.ts` for the database test files from
Vitest's); `MELARC_DB_SHARD=<shard>/<shards>` runs one shard of the database tests locally too, and the gate and the affected run
never set it. Every step that runs tests has a timeout of its own below its job's, the diagnostics are kept when a job fails and when
it is cancelled, and the Playwright browsers are cached by the lockfile. Nothing here can be tried on a machine without a push,
which the owner authorizes.

## 2. Create the local settings

```text
pnpm run setup:env
```

This creates two git-ignored files from their committed examples and prints no secret:

- `infrastructure/postgres/.env`: random, throwaway passwords for the database's three identities (the cluster
  superuser, the migration identity and the API's runtime identity), the host and the port.
- `apps/api/.env`: the API's settings, with `DATABASE_URL` using the runtime identity and the same password, and a
  fresh random key for each of the five key purposes (`totp_seed`, `credential_delivery`, `idempotent_replay`,
  `limiter_digest`, `password_pepper`). These keys are throwaway local substitutes, not KMS-backed custody: nothing
  they protect is real, and production refuses to start on them.

It never overwrites a file, so it is safe to run again. If an existing `apps/api/.env` has no readable `DATABASE_URL`
(an older copy of the example), lacks a setting the API now requires, or its password no longer matches the database
settings, it says so by name (the settings it lacks are listed, never a value); delete that file and run the command
again to have it rebuilt. **A `.env` made before the key settings existed lacks them, and the API refuses to start until
it is rebuilt or they are added.** The passwords are only ever used on your machine.

## 3. Start the database

```text
pnpm run infra:up
pnpm run infra:status
pnpm run infra:check
```

`infra:up` starts the `melarc-db` container (PostgreSQL 18.6, [compose.yaml](infrastructure/postgres/compose.yaml))
and waits until it is healthy. It listens on loopback only, `127.0.0.1:5432`, and keeps its data in the Docker volume
`melarc_pgdata`, so it survives a stop. `infra:status` should show it `healthy`. `infra:check` opens one connection to
the address the database tools use and says whether a PostgreSQL server answers there. It sends no password and
changes nothing, and when it fails it says why and what to do.

**Or a native server, without Docker.** A PostgreSQL 18 installed on this machine works the same. Set
`MELARC_PG_PORT` in `infrastructure/postgres/.env` to its port, the same port in `DATABASE_URL` of `apps/api/.env`,
and `MELARC_PG_ADMIN_PASSWORD` to the password of its `postgres` superuser; make it listen on this machine only
(`listen_addresses = 'localhost'`). Then skip `infra:up`: `infra:check` works the same, and step 4 creates the roles and
the database. `infra:up`, `infra:down` and the volume belong to the container alone.

## 4. Build and migrate

```text
pnpm run build
pnpm --filter @melarc/api run db:bootstrap
pnpm --filter @melarc/api run db:migrate
```

The database tools run from the build, so build first. `db:bootstrap` creates the roles (the owner, the migration, API
runtime, worker and provisioning identities, and the worker's two capability roles, for the credential delivery and for the notification lane) and the `melarc_dev` database. The worker
and provisioning logins take passwords derived from the administrator password, which is for this machine's cluster only,
so they need no setting of their own. `db:migrate` applies the migrations in `apps/api/migrations` as the migration
identity. Both are safe to repeat; run `db:bootstrap` before `db:migrate` after updating, because a migration grants to
the roles it names.

```text
pnpm --filter @melarc/api run db:seed
```

`db:seed` fills the migrated, empty `melarc_dev` with the reference data (the permission catalogue, the confirmed role
bundles and their grants, the two fixed Vendor and Rider policies, the settings with an approved value, the hub and the
twelve identity reasons, and the launch hub's service zones and settings) as the provisioning login, in one transaction, by a database function that only that login may run
(the login holds no privilege on those tables, so nothing else of it can add to them). The database, not the command, refuses
to run it twice: it refuses a database that already holds any of it, and changes nothing. `db:seed --hub-configuration` writes the launch hub's service zones and settings alone, into a database that was seeded before migration 0042 (it refuses one that already has any of them; it is reference data, so production may run it). `db:seed --fixtures` adds the test-only fixtures and refuses in production.
For another database set `DATABASE_SEED_URL` (the provisioning login) and `APP_ENV`; the API refuses to start with either
`DATABASE_SEED_URL` or `DATABASE_MIGRATION_URL` in its environment. `db:reset` (section 8) returns the database to migrated and empty, which allows a new seed.

```text
pnpm --filter @melarc/api run bootstrap:seed -- --custodian "Full Name <work@email>" --custodian "Full Name <work@email>"
pnpm --filter @melarc/api run bootstrap:resume -- --custodian <work@email>
```

`bootstrap:seed` makes the two bootstrap administrators of an empty staff table and writes one custody bundle for each into
`BOOTSTRAP_CUSTODY_DIRECTORY` (an absolute folder outside the checkout, with no default); `bootstrap:resume` gives one stranded
administrator a fresh secret in a new bundle. They run as the provisioning login after the reference seed, under the same
`DATABASE_SEED_URL` and `APP_ENV` rules, and they are processes you start: no API operation or screen can run them. A bundle holds
a setup secret in clear: give it to its custodian alone, delete it after handover, keep the folder out of any synchronised or shared
location (a cloud-synced profile folder copies it), and never create one on a machine you do not trust (the plan's open item
names this one). Neither command prints a secret, a work email or a path
([MIGRATION_AND_SEEDING.md](architecture/MIGRATION_AND_SEEDING.md) §3.2 and §3.3a).

Setting the folder: name it in the shell the command is started from (`set BOOTSTRAP_CUSTODY_DIRECTORY=...` in `cmd`; the scripts read no
`.env` file for it, so a line in `apps/api/.env` does nothing). **Use one folder for each environment.** Each bundle records which
database it was written for, and a run removes only the earlier bundles of its own database (a run that did not commit leaves such
a bundle); it leaves any other in the folder alone and says how many. The folder must be private before the command is started, and the
command refuses one that is not: on POSIX it is owned by you with no access for group or others, and on Windows its access list names
no one but you, the local system and the administrators (a folder under your user profile does; a folder directly on a data drive
usually does not, because the drive grants Users and Authenticated Users access). The command only reads the list of the folder; it
never changes it. A bundle that is found in the checkout is refused by `pnpm run package:source` by its name and by what it begins with.

## 5. Run the applications

In two terminals:

```text
pnpm --filter @melarc/api run start:local
pnpm --filter @melarc/ops-web run dev
```

The API reads `apps/api/.env` and has no watch mode: after changing API code run `pnpm run build` and start it again.
Check it is up and connected to the database:

```text
curl http://127.0.0.1:3000/livez
curl http://127.0.0.1:3000/readyz
```

`/readyz` answers ready only while the database is reachable and the reference seed has run on it (`503` with `reference_data_missing` otherwise: run `db:seed`). The Ops dev server listens on `http://127.0.0.1:5172` and
no other port (it stops if that port is taken), because that is the one origin the API allows (`OPS_ORIGIN`), and it
forwards `/api/v1` to the API, so the browser only ever talks to its own origin. Open exactly that address: `localhost`
can lead to another server or to none, and a sign-in from any other origin is refused with 403 ("The request could not be
verified"). It is not Vite's usual 5173, which other projects on the same machine take.

### First sign-in

Nobody can sign in until `db:seed` and `bootstrap:seed` (section 4) have run on this database. `/readyz` checks for the
first: it answers `503` with `reference_data_missing` until `db:seed` has run. If sign-in answers `503` all the same and the API log
says a setting "has no approved value", the seed ran against another database or an older version of it.
There is no preset password. Each of the two bootstrap administrators sets their own, with the one-time secret in their
custody bundle and an authenticator app of their own:

1. Open the bundle (a `melarc-bootstrap-<random>.bundle` file in `BOOTSTRAP_CUSTODY_DIRECTORY`) that names the
   administrator on its `custodian:` line. The line under `secret:` is the secret. It is not a link: in the browser open
   `http://127.0.0.1:5172/setup/credential#token=` followed by the secret. Use that address and not `localhost`: the API
   accepts only the origin in `OPS_ORIGIN`.
2. Choose a password (12 to 128 characters), add the authenticator by scanning the code or typing the setup key, and enter
   the six digits it shows.
3. Sign in at `http://127.0.0.1:5172/sign-in` with the work email, the password and a code. You land on the Overview, with
   Staff, Add a staff profile and Sessions in the menu.

Delete the bundle after use; a lost or used secret is replaced with `bootstrap:resume`. One administrator is enough to see
every screen, and to add a profile and approve it: a Platform Admin approves a profile they made. The other
administrator is needed to reset an authenticator, and to see a profile that a different person approved.

The credential-delivery worker is a third process, with no listener, that sends the messages the API queues: the setup
link of an approved profile, a re-sent setup link and the link to set up a new authenticator after a reset. Start it
whenever you do one of those, or the person never receives the link:

```text
pnpm --filter @melarc/api run start:worker:local
```

It reads the same `apps/api/.env` and connects as `melarc_worker_runtime`; a local run derives that login's password from
the local cluster's settings, as `db:seed` does, so `DATABASE_WORKER_URL` stays unset (the API refuses to start with it
set). It sends through the capture adapter only: each message is written, in clear and with its link, to a folder of
yours outside the repository (`DELIVERY_CAPTURE_DIRECTORY`, by default `~/.melarc/capture`), where you follow the link
by hand. The worker refuses a folder inside the checkout and refuses to select a real provider for these credential
messages in a local run (the decision of 11 October 2026 stands for them).
It reads the standing of a setup grant (SLICE-000 S0.29) or of a recovery request (S0.50) before each send, and sends nothing
for a record it cannot confirm. Stop it with Ctrl+C: it stops claiming, finishes or gives back what it holds, and exits 0.

The same process runs the **notification lane** (SLICE-001, S1.12). When an operation of the API records an event the
product tells people about (today, Ops confirming a pickup request), the lane relays it and texts the people it concerns:
the ad-hoc sender of a request gets a text, and a registered vendor gets an entry in its feed. By default the texts go to the
capture folder too, one `<id>.json` file for each (the number and the words, in clear, for you to read); the message log of
the database keeps a masked hint of the number and never the words. The wording of the messages is a draft until you approve
it ([the plan](delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md), S1.12b).

Ops reads what became of each message in the Ops Portal at **Messages** (`/messages`, the key `notification.read`, which Ops Staff,
Senior Ops and Platform Admin hold at their hub): when it was made, who it was for, and whether it was sent, delivered, held back
(and why) or failed, with the number masked and never the words or a code. Migration `0057` grants the key to a database seeded
before it; a session already open keeps the keys it was issued with, so **sign out and in again** to see the new menu entry.

#### Real text messages: the controlled window (S1.12d)

The lane can send real text messages through Hubtel, on this machine, only inside a window you open and that closes by itself
(DEPLOYMENT_AND_ENVIRONMENTS.md §4.1, your decision of 29 October 2026). Nothing is sent for real until you do the following,
and nobody else can do it for you:

1. Copy `apps/api/.env.sms.example` to `apps/api/.env.sms` (git-ignored; the API never loads it) and fill it in yourself: your
   Hubtel client id and secret, the sender ID, the numbers you control (`DELIVERY_PROVIDER_ALLOWLIST`, in the form
   `+233XXXXXXXXX`), the most messages the window may send, the moment it ends (UTC, within 14 days of the worker's start) and an
   approval reference. **Never paste a credential in a chat, a log or a commit.** Renew a window with a new approval reference.
2. Run `pnpm run build`, then `pnpm --filter @melarc/api run db:bootstrap` and `db:migrate` (the lane has a capability role of
   its own, and the migration grants to it).
3. Send yourself one message and read what happened:

   ```text
   pnpm --filter @melarc/api run sms:smoke -- --to +233XXXXXXXXX
   ```

   It reads the settings as the worker does, refuses what the worker would refuse (an incomplete window, a number off the
   allow-list, a window that has ended, a spent cap), sends your number one test text through the guards, and waits up to a
   minute for the network's word. It prints what happened in words, a masked form of the number, and never a credential. With
   `NOTIFICATION_SMS_ADAPTER` unset it is a dry run into the capture folder.

4. Start the worker with `start:worker:local` (it loads `.env.sms` after `.env`). The lane then sends a real text for an
   event only if the number is on the allow-list, the window is open and has a free place, the day's limits allow it (10 for a
   number and 500 in all, settings you can change) and **the wording of that message is approved**. You approved the two
   wordings built so far (the confirmation text and the vendor's feed entry) on 30 October 2026, for exactly those words; the
   wording of every later message is a draft until you approve it in `apps/api/src/platform/notifications/templates.ts`, and the
   lane holds its real messages back as `WORDING_NOT_APPROVED` (the capture folder still gets them). The worker says at its start
   which mode it composed (`notification lane composed`: the sender, and whether the wording gate stands in front of it).

Hubtel's request and answer forms are built from what is known of its API and marked unverified in
`hubtel-sms-client.ts`; the first message you send confirms them or shows what to correct.

#### The private metrics endpoints

The API and the worker each have an endpoint of their own for their counters, and neither is a route of the API: the public
port has no `/metrics`. Each is off until its port is set in `apps/api/.env` (`METRICS_PORT` for the API,
`DELIVERY_WORKER_METRICS_PORT` for the worker; two different ports, neither the API's `HTTP_PORT`), listens on the loopback
address unless `METRICS_HOST` or `DELIVERY_WORKER_METRICS_HOST` says otherwise, and answers `GET /metrics` alone in the
Prometheus text format. Off the loopback address it needs a secret (`METRICS_SECRET`, `DELIVERY_WORKER_METRICS_SECRET`) that the
scraper sends as `Authorization: Bearer`. The worker's also serves the age of the oldest message due to be sent. Nothing in
either carries an identifier. The alert rules that read them are `apps/api/src/platform/metrics/alert-rules.ts`; which tool
evaluates them in production is release gate G3 ([OBSERVABILITY_AND_RECOVERY.md](architecture/OBSERVABILITY_AND_RECOVERY.md) §3).

## 6. Run the checks and the smoke tests

These are the checks CI runs ([ci.yml](.github/workflows/ci.yml)), which also runs `pnpm run build`,
`pnpm --filter @melarc/api run db:check` and `pnpm audit --audit-level high`. The order to run them in, and the commands
that run all of them once, are in [The development loop and the gate](#the-development-loop-and-the-gate) below.

| Command                                                        | Needs                           | Proves                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` | nothing                         | formatting, lint (one ESLint run for each workspace through Turborepo, cached, then one for the files the root owns: the type-aware lint of the whole repository in one process needed 6 GB, and each workspace needs less than 4 GB, the largest, `apps/api`, about 3.8 GB), strict types |
| `pnpm test`                                                    | nothing running                 | unit, component and process tests of every workspace, and the repository's tooling tests                                                                                                                                                                                                   |
| `pnpm run contract:check`, `pnpm run api-client:check`         | a build (step 4) for the first  | the implemented operations (none yet) match the contract; the generated client is current                                                                                                                                                                                                  |
| `pnpm run test:db`                                             | the database (step 3), a JDK 21 | migrations, roles, row-level security and connection handling against a real server; the attested rider enrolment and the alert rehearsal against the real verifier service (built on its first run)                                                                                       |
| `pnpm run test:browser`                                        | Chromium (step 1)               | the Ops shell and components in real browsers (Chromium; CI also runs Firefox and WebKit)                                                                                                                                                                                                  |
| `pnpm run test:e2e`                                            | the database, Chromium, builds  | a real browser, the API and a disposable database together                                                                                                                                                                                                                                 |
| `pnpm run verifier:test`                                       | a JDK 21                        | the attestation verifier: its vendored library, its build and every one of its tests                                                                                                                                                                                                       |

```text
pnpm test
pnpm run test:db
pnpm run test:browser
pnpm run test:e2e
```

**A lower-concurrency local run.** `pnpm test` runs the package suites at the same time. On some developer machines the Ops
Portal suite then fails to start its workers (`Timeout waiting for worker to respond`); the cause is not established, and
nothing here explains it. `pnpm run test:local` runs the same root tests and the same package tests, with the same assertions
and timeouts, one package suite at a time (`turbo run test --concurrency=1`). It stops at the first failure, retries nothing
and is slower. It is bounded local scheduling and not a fix: CI keeps `pnpm test`, and a failure under either command is a
failure to be explained, not retried.

```text
pnpm run test:local
```

### The development loop and the gate

A full run of every check takes about an hour on a developer machine, so the order of the checks matters as much as the
checks. The hour is lost, and lost again, in three ways: a cheap check fails late (a stale generated client, a
formatting slip); a file is edited while the run goes on, so its result describes a tree that no longer exists; or two
heavy runs share the machine and each fails for the load of the other. The loop below prevents all three. While a task
is developed it runs only the tests a change can reach, and says what it left; the gate, which the owner starts, skips
no check, retries nothing, shards nothing and gives no timeout more time. Neither changes what a check proves.

1. **While editing**, run the tests your change reaches: `pnpm run test:affected` (step 4), or one test file, never a
   whole suite. A slice's plan may add a run of its own: SLICE-000's
   [testing cadence](delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#3-rules-every-task-keeps) adds the end-to-end
   journeys for a task whose evidence names them.
2. **After a change to a contract, a schema, a migration or a document, and before a task is handed over**, run
   `pnpm run precheck`. It runs the cheap checks of CI (the migration journal, the migration files main has, the generated client, formatting, types,
   the build, the contract check and lint) and the dependency audit, which asks the package registry and so needs the
   network, in parallel, with the content cache of the formatter and turbo's
   task cache (which serves lint, one task for each workspace) switched on, and prints the end of the log of any that fails. It takes seconds when little has changed and
   a few minutes on cold caches, and exits 0 only when every check passed. It is not a gate and says nothing about a
   test, and it refuses to run while a gate runs. Its one weakness is turbo's cache of lint: a workspace whose files, and whose dependencies' files, did not
   change is not linted again, so a rule that reads something else can hide a finding that the gate's lint from scratch reports.
   `pnpm run precheck --uncached` runs the real commands. **The migration check** holds the migration files to the merge base of `HEAD` with main, and ends with one of three
   exits, the same in CI and outside it: `0` held; `1` a migration main has was changed, renamed or removed, or the command was misused (an option it does not know, or a base
   that was named and is empty or is not a commit this clone has); `2` it could not tell (a tree with no main, a shallow clone, a base with no migration in it). **What `2`
   costs is for whoever runs it to say.** The precheck shows it as `warned`, with the script's words in its summary and the count (`No cheap check failed, and 1 warned
(migrations)`), and exits 0, so that a source package or a clone that fetched no branch is not stopped but is told that nothing was held; **the gate and CI fail on it**, as
   they fail on any exit but 0. `MELARC_MIGRATION_BASE=<revision>` (or `node scripts/migration-immutability.ts --base <revision>`) names a revision of this tree to hold the
   migrations to, and then it can decide. A base that is **named and empty** (`MELARC_MIGRATION_BASE=` with nothing after it, a variable that was not filled in, `--base ""`)
   or **mistyped** fails with exit `1` everywhere, and is never read as "none named"; the all-zero revision that a push event names for a new branch is none named. CI names
   the revision a push to main came from by writing `MELARC_MIGRATION_BASE` to the environment of its later steps on a push only: an `env:` expression would be empty on a
   pull request, and the workflow check (`scripts/ci-workflow.ts`) refuses it, as it refuses a step that sets `CI` to anything but `true`.
3. **Regenerate derived files last.** The generated API client (`pnpm run api-client:generate`) is made after the final
   edit of what it derives from. One made earlier is stale, and `api-client:check` fails on it.
4. **Before a task is handed over, run `pnpm run test:affected` once, on the final state,** after the precheck. It
   chooses the tests a change can reach and runs only those, the parallel Vitest suites with four workers (`--workers`
   sets `MELARC_TEST_WORKERS`, which every Vitest configuration reads):
   - What changed. Each target (the root tests, the client, the harness, the Ops Portal's unit tests and its browser
     specs in Chromium, the API's unit, process and database tests, the verifier and the end-to-end journeys) is
     compared with the tree of its last green run, which an affected run or a gate records. Nothing has to run first: a
     target with no record is compared with the last commit, so it runs whole while the working tree differs much from
     that commit, and its first green run records it. `--since <revision>` compares with that revision instead.
   - What a change reaches. A test that imports a changed file through any chain of imports; a test that reads files
     and names the changed one, or, in the cheap suites, any test that reads files when its package changed; an API
     test that starts a process when the API's source changed; every browser spec of a page that changed, every spec
     when the application shell changed; a whole target when its configuration, a migration or the server's image
     changed; everything when the lockfile, the workspace or the Node pin changed. What it cannot place runs more,
     never less. `--dry-run` says what it would run and why, `--only <targets>` narrows it.
   - On request. Three parts are reported as owed when a change reaches them, and run only when asked; the gate runs
     them all (the owner's decision of 27 October 2026). The end-to-end journeys run with `--with-e2e`. The API's
     process tests run with `--with-process`, or by themselves when the change touches what only they test: start-up,
     configuration, shutdown, the logs, the probes, the command-line tools, or those tests and their helpers. The
     development-server project of a browser spec that also runs against the production build runs with
     `--with-dev-browser`. The browser target's record moves on the projects it ran.
   - The record. A target's record moves only when every test chosen for it passed on a tree that did not change while
     they ran, so a failing test keeps being chosen until it passes. It lives below `node_modules/.cache`, and
     `--forget` drops it.
   - One at a time. It refuses to start beside a gate or another affected run (they would share the browsers' ports,
     the database server and the memory, and each fail for the other), and a gate refuses to start beside it.
   - The result. Its last lines say what passed and, as `Owed:`, what the change reaches that did not pass here: the
     end-to-end journeys left to the gate and every target that could not run, each with its reason. Exit code 0 means
     every test chosen passed, 1 a test failed or the API they needed did not build, 2 it would not start or a target
     could not run here (the database does not answer, no JDK 21 for the verifier or for the database tests that start
     it) and 3 the tree changed while it ran.

   It is not a gate. Report what it chose, what passed and what it left owed, never as the gate's result.

5. **The gate is the owner's full run: `pnpm run gate`.** The owner starts it when they want the whole proof, at the
   end of a stage and before a commit or a pull request; an agent starts it only when the owner asks for it in the
   task, and then with `--asked`, without which the gate refuses an agent (the owner's decision of 27 October 2026).
   Start it in the background and leave the tree alone: it runs for about an hour. It runs every command of CI that this machine can run, once, uncached and one at a time:
   - The cheap checks first, all of them. If any fails, no test starts: tests of a tree that fails its cheap checks
     prove nothing. Then the tests (`pnpm run test:local --continue`, `verifier:test`, `test:db`, `test:browser`,
     `test:e2e` and the audit), all of them whatever one did, so that one run shows everything that is wrong. `--profile ci` runs
     `pnpm test` as CI does. The HTTPS end-to-end run is left to CI: it makes a certificate authority and refuses to run
     on a developer machine.
   - The tree held still. It takes a fingerprint of every file Git tracks or sees as new and not ignored, and ends the
     run as `UNSETTLED` (exit code 3) when one changes: an edit, a new file, or a file one of its own stages leaves in
     the tree. That result is void, whatever its stages said. A file a test makes and removes again is not a change.
   - The machine looked after. It refuses to start with less than 2 GB of memory free (`--allow-low-memory` accepts the
     risk) and warns below 4 GB, because a run that starves fails for the machine and says nothing about the code. It
     refuses to start beside another gate or an affected run, and while the database does not answer (`pnpm run infra:check`): the database
     stages come half an hour in, and starting the database (step 3) is yours, never the gate's. It refuses to start,
     too, without the JDK 21 that the verifier stage and two database tests need
     ([the attestation verifier](#the-attestation-verifier)), for the same reason. It records the lowest
     free memory seen during each stage, and lists the test databases left behind, which it never drops (step 8). Every
     Vitest configuration runs four workers (`MELARC_TEST_WORKERS`; the API's parallel database files three,
     `MELARC_DB_WORKERS`): at Vitest's default the suites left this machine with no free memory and failed tests that
     pass alone. Never set `VITEST_MAX_WORKERS`: Vitest applies it to every project, so the API's one-at-a-time tests
     would run side by side. The API's configuration refuses it, and the gate and the affected run remove it.
   - The record. One log per stage and a `summary.txt`, in `melarc-gate/<name>/` below the operating system's temporary
     folder (`--name` names it; the default is the date and time). Exit code 0 means every stage passed on a tree that
     stayed the same, 1 a check failed, 2 it would not start, 3 the tree changed and 130 it was stopped. Each test stage
     that passed on the settled tree is recorded as the last green run of the targets it ran whole, so the next
     `pnpm run test:affected` starts from there.
6. **Watch and stop it with its own commands.** `pnpm run gate:status` says where it is (add `--wait 540` to wait for
   the next stage to end). `pnpm run gate:stop` asks the runner to stop, which ends the stage it started, with everything
   that stage started, and records the stop; only if the runner has not stopped within 30 seconds does it end that stage
   and the runner itself. It touches no other process. A stage ended half way can still leave a test database (the
   summary lists them; step 8 says how one is removed).
7. **Report what it says.** A gate that failed is reported as failed, stage by stage. A later run of the failed parts
   is a diagnosis and not a gate: the parts that passed did so on another tree. Fix, run the precheck, run a new gate. A
   gate that ended `UNSETTLED`, was stopped or would not start has not run: say so, and run it again.
8. **CI is the parallel gate.** [ci.yml](.github/workflows/ci.yml) runs the same commands as parallel jobs on clean
   machines, the HTTPS run included (in three jobs, a shard of its runs in each), the database tests (in a job for each shard) and the
   browser tests (in a job for each shard of each engine, which together run every test once), and is the quickest complete run. A pull request runs the Chromium
   shards of the browser tests and a push to main, the nightly run and a manual run run those of all three engines
   ([what CI runs when](#what-ci-runs-when)). It needs a push, which the owner authorizes: do not push to get a run unasked.

What looks like a saving and costs the proof: wrapping a gate, or any long run, in `timeout` (it can end the wrapper and
leave what the wrapper started running, or kill a stage half way; either way test databases and temporary folders are
left behind and nothing records it, where `pnpm run gate:stop` ends the whole stage and lists what it left); editing the
tree, or starting another build, lint or test, while a gate runs; raising a timeout, adding a retry, skipping or
sharding a test (CI shards the browser tests across jobs that together run every one; a gate on one machine runs them
whole), or running the package suites side by side to finish sooner. On a machine of this size that last one is
how test workers fail to start, and the failure is then the machine's and not the code's. Two savings were measured and
are not worth having: ESLint's `--concurrency` (no faster here, and it leaves the machine with almost no free memory)
and a template database for the database tests (about a minute of the nineteen they take). And an affected run is
never a gate: it chooses tests by what it can read of the code, and a test it cannot tie to a change waits for the gate.

```text
pnpm run test:affected
pnpm run precheck
pnpm run gate
pnpm run gate:status
pnpm run gate:stop
```

### The attestation verifier

The private service that judges a Rider handset's device attestation ([apps/attestation-verifier/](apps/attestation-verifier/CLAUDE.md)) is a JVM
program built by Gradle, not a pnpm package, so it is not in `pnpm install`, `pnpm test` or `turbo`: it has commands of its own, and CI and the gate
run the first. All of them need a **JDK 21** (the major version of [.java-version](.java-version); Eclipse Temurin is what CI uses): set `JAVA_HOME`
to it or put it first on the path. So does `pnpm run test:db`, whose attested-enrolment test builds and starts the service, and the gate and
the affected run check for it before they start what needs it (`scripts/jdk.ts`). A missing JDK, another major version or a JRE ends the command with exit code 2 and says how to install one.
Nothing else needs installing: the Gradle wrapper downloads its pinned Gradle (held to a checksum) and every dependency is held to the checksum in
`gradle/verification-metadata.xml`, so the first run needs the network and takes a few minutes.

```text
pnpm run verifier:test
pnpm run verifier:build
pnpm run verifier:start
pnpm run verifier:status
pnpm run verifier:stop
```

`verifier:test` runs Gradle `check` without a daemon, so nothing stays running afterwards: the vendored library against its checksums, the
compiler and every test (about a minute once the downloads are cached). `verifier:build` makes the runnable folder
`apps/attestation-verifier/service/build/install/attestation-verifier`.

To run the service, copy `apps/attestation-verifier/.env.example` to `apps/attestation-verifier/.env` (git-ignored) and fill in the three release inputs
that have no default: the Rider package name, the SHA-256 digests of its signing certificates, and (when the verifier is not on loopback) the shared
secret. `verifier:start` builds the service, starts it in the background on `127.0.0.1:8765` and waits until it answers; its trust data (the accepted
roots and Google's revocation list, fetched over HTTPS) loads in the background, and `verifier:status` says `READY` when it has. It gives the service
its own settings and nothing else of your environment, writes its log below the operating system's temporary folder and records the process it
started there: `verifier:stop` ends that process and no other (it checks the command line first, so a recycled process id is never touched).
On Linux or WSL2 install `temurin-21-jdk` (or `openjdk-21-jdk`) with your package manager; the Gradle wrapper is started with `sh`, so no file mode
matters.

### The two-build proof, the concurrency run, the alert rehearsal and the capacity measurement

Four database tests of SLICE-000 Stage 8 need the database like the others; each runs alone, in
`apps/api/test/database/alone/`, and two of them start processes:

- `two-builds.db.test.ts` compiles the API twice from the tree (the current build, and a release with a higher compiled
  policy revision and a changed predicate) into `apps/api/.policy-release/`, which git ignores, and starts both on one database.
  A cold compile takes 15 to 20 seconds, and a tree that has not changed reuses it; delete the folder to force a compile.
- `concurrency.db.test.ts` runs randomised interleavings by seed, in the test's own process (it starts none). It prints each
  seed it ran; to run one again, set `MELARC_CONCURRENCY_SEED` to it (a whole number). The seed fixes the schedule of the
  operations, not what the database does between them, so a failure is read from its printed outcomes and not only repeated.
- `alert-rehearsal.db.test.ts` runs the alert rules on the readings of the real delivery queue, the worker's metrics endpoint
  and the attestation verifier service, which it builds and starts: it needs a **JDK 21** like the attested rider enrolment
  ([the attestation verifier](#the-attestation-verifier)), and its last test waits for the verifier's once-a-minute look at
  its roots file, so the file takes about two minutes. To run it alone:

```text
pnpm --filter @melarc/api exec vitest run --project database-alone test/database/alone/alert-rehearsal.db.test.ts
```

- `capacity-benchmark.db.test.ts` measures sign-in, an authenticated read and a refusal at rising concurrency, and is skipped
  unless asked. Run it on an idle machine, with nothing else open, in `cmd`:

```text
set MELARC_BENCHMARK=1&& set MELARC_BENCHMARK_OUTPUT=%TEMP%\melarc-capacity.json&& pnpm --filter @melarc/api exec vitest run --project database-alone test/database/alone/capacity-benchmark.db.test.ts
```

The raw figures of a run are written, as JSON, to the file `MELARC_BENCHMARK_OUTPUT` names (the report quotes them; the
maxima are only there). To repeat the report's three- and four-slot rows, add `MELARC_BENCHMARK_HASH_SLOTS=3` and
`MELARC_BENCHMARK_THREADPOOL=4`, or `=4` and `=8`, to the command in the same way.

The single-hash measurement of the Argon2id cost is `node apps/api/dist/tools/benchmark-argon2.js --runs 15` after a build
(the report's table is 15 runs; the default is 9), once for each profile, named with `--memory-kib`, `--passes` and
`--parallelism 1`. What they measured, on which machine, and the values they propose are in
[SLICE-000-CAPACITY-REPORT.md](delivery/planning/SLICE-000-CAPACITY-REPORT.md): proposals for the owner, never settings.

## 7. Stop safely

Press Ctrl+C in each application terminal; the API finishes in-flight requests and closes its database connections
before it exits. Then stop the database:

```text
pnpm run infra:stop
```

That stops the container and keeps its data. Start it again with `pnpm run infra:up`.

## 8. Reset to a known state

The development database, dropped, created again and migrated. It refuses any server that is not on this machine and
any database that is not a disposable `melarc_dev` or `melarc_test` one:

```text
pnpm --filter @melarc/api run db:reset
```

Databases left behind by a test run that was killed are listed (nothing is removed) with the first command below; one
is removed by naming it after `--drop`, and `--disconnect` is needed if something is still connected to it:

```text
pnpm --filter @melarc/api run db:orphans
```

To throw away everything the database holds, volume included, then rebuild it from nothing. This deletes all local
data in `melarc_pgdata`. It is the simple way to a clean slate, not something a password change needs:

```text
pnpm run infra:stop
docker compose -f infrastructure/postgres/compose.yaml --env-file infrastructure/postgres/.env down --volumes
pnpm run infra:up
pnpm --filter @melarc/api run db:bootstrap
pnpm --filter @melarc/api run db:migrate
```

To change a password and keep the data, edit `MELARC_PG_MIGRATION_PASSWORD` or `MELARC_PG_RUNTIME_PASSWORD` in
`infrastructure/postgres/.env` and run `db:bootstrap`, which sets both passwords again every time it runs (the database
tests prove that the runtime password changes and the old one stops working). For the runtime password also put the new
value in `DATABASE_URL` in `apps/api/.env` and restart the API. The cluster superuser's password,
`MELARC_PG_ADMIN_PASSWORD`, is the exception: PostgreSQL reads it only when the volume is first created, so changing it
in the file later leaves `db:bootstrap` unable to sign in. Put the value the volume was created with back, or use the
reset above.

## 9. Package the source for review

Share the source as an archive the repository makes, never as a ZIP of the folder. The folder holds your populated
settings files, the dependencies and the build output, and `.gitignore` protects Git, not an archive.

```text
pnpm run package:source
```

It starts from what Git knows (tracked files, and untracked files that are not ignored) and writes
`melarc-source-<revision>.zip` in the git-ignored `tmp` folder of the repository (`-modified` is added when the working
tree differs from the commit; `--out <file>` chooses another place). It refuses by name settings files (`.env` and
`.env.*`, except the `.env.example` files), keys and certificates, `node_modules`, build and test output, scratch
folders, Git metadata and earlier archives, even where Git would include them. It then reads the credentials out of
your local settings files and stops, writing nothing, if one appears inside a file it would pack. It prints paths and
counts, never a value, and it never changes or deletes a file in your working tree.

The archive holds the working tree as it is, so it can be reviewed before it is committed. `SOURCE_PACKAGE.json` inside
it names the commit the tree sits on, says whether the tree is modified, lists the changed paths and gives every file's
SHA-256. The same tree gives the same bytes, and an existing file is replaced only with `--overwrite`.

If an archive of the folder itself, settings files included, went to anyone who should not hold those credentials,
treat the local passwords as exposed and change them as step 8 describes. They only protect your own throwaway local
database, which listens on loopback.

## Windows, WSL2 and Linux

- **Windows.** Use the commands above in any shell. Six API tests (under `pnpm test`; one is the delivery worker's), two
  more under `pnpm run test:db` (one is the worker's) and one harness test need to receive `SIGTERM`, which Windows
  cannot deliver to a process, so they are skipped there and run on Linux, in WSL2 and in CI. Two more tests of
  `pnpm test` read the permission bits of the delivery worker's capture folder, which a Windows file system does not
  have, and are skipped there too. A skipped test is not a pass: run the suite in WSL2 or Linux before relying on
  shutdown behaviour.
- **Linux and CI.** The same commands. CI runs them on Ubuntu with a PostgreSQL service container.
- **WSL2.** Clone into the Linux filesystem (`~/Melarc`), not under `/mnt/c` or `/mnt/e`: it is much faster and keeps
  file permissions. Install Node and pnpm inside WSL2 and run every command on this page in the WSL2 shell.

  The database is the part that depends on your setup. Inside WSL2, `127.0.0.1` is the WSL2 virtual machine, not
  Windows, unless WSL2 uses mirrored networking; and the database is published on loopback only. Whether a database
  that was started from Windows is at `127.0.0.1:5432` for a WSL2 shell therefore depends on how Docker is installed
  and how WSL2 is configured, and this page does not assume it. Ask the machine:

  ```text
  pnpm run infra:check
  ```

  If it says PostgreSQL answers, carry on. If it does not, use one of these two setups:

  1. **The database inside WSL2.** Make Docker available in the distribution (Docker Engine installed in it, which is
     plain Linux, or Docker Desktop with its WSL integration enabled for it) and run `pnpm run infra:up` from the WSL2
     shell. Run only one `melarc-db`: its name and port 5432 are taken by the first.
  2. **The database on Windows, the rest in WSL2.** Turn on mirrored networking, which makes `127.0.0.1` in WSL2 reach
     servers on Windows (Windows 11 22H2 or later; Microsoft's
     [WSL networking page](https://learn.microsoft.com/en-us/windows/wsl/networking) describes it).
     Put these two lines in `%UserProfile%\.wslconfig`, run `wsl --shutdown` from Windows, then open WSL2 again and
     run `pnpm run infra:check`:

     ```text
     [wsl2]
     networkingMode=mirrored
     ```

  Never bind PostgreSQL to all interfaces, publish it on a network address, or point `MELARC_PG_HOST` at another
  machine to make a setup work. The tools refuse any host that is not this machine, and the database must stay on
  loopback. In WSL2's default networking the Windows host is reached by its own address, which is not loopback, so a
  Windows-hosted database that `infra:check` cannot reach is not fixed by changing the address: use one of the two
  setups above.

  Not verified: neither setup has been run on a WSL2 machine for this repository, and nor has whether Docker Desktop's
  WSL integration lets a distribution reach a port published on `127.0.0.1`. `infra:check` is how you find out on
  yours. A full run of this page in WSL2 is still to be done ([runbook B0.10](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md)).

## When something goes wrong

- **`PostgreSQL is not reachable ... ECONNREFUSED`:** Docker is not running or the container is stopped. Run
  `pnpm run infra:status`, then `pnpm run infra:up`, then `pnpm run infra:check`. In WSL2 the database may be running
  where this shell's `127.0.0.1` does not reach: see the WSL2 section above.
- **Port 5432 is taken** by another PostgreSQL on this machine. Set `MELARC_PG_PORT` in
  `infrastructure/postgres/.env` and the port in `DATABASE_URL` in `apps/api/.env`, then recreate the container
  (`down` without `--volumes`, then `pnpm run infra:up`). The tools only ever act on a server on this machine, and they
  must only be pointed at the one this repository started.
- **Port 3000 (the API) or 5172 (the Ops dev server) is taken** by another project. For the API set `HTTP_PORT` in
  `apps/api/.env`, then copy `apps/ops-web/.env.example` to `apps/ops-web/.env` and set `OPS_API_PROXY_TARGET` to the
  API's new address. The dev server never moves to another port, because the API allows exactly one origin: to move it,
  change `port` in `apps/ops-web/vite.config.ts` and `OPS_ORIGIN` in `apps/api/.env.example` and `apps/api/.env`
  together (`apps/ops-web/test/dev-server-origin.test.ts` holds the first two together), then restart the API.
- **Password authentication failed after a password in `infrastructure/postgres/.env` changed or the file was
  regenerated:** the server still holds the passwords it was given. Run `db:bootstrap` (step 4), which sets the
  migration and runtime passwords from the file, and make `DATABASE_URL` in `apps/api/.env` carry the runtime one. If
  `db:bootstrap` itself cannot sign in, `MELARC_PG_ADMIN_PASSWORD` no longer matches the volume: put back the value
  it had when the volume was created, or use the full reset in step 8.
- **A browser download times out:** on a slow or filtered connection, retry with a longer connection timeout, for
  example `PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000`. That is generic advice and it does not help in the
  following case.
- **A browser download fails after about six seconds, whatever timeout is set, and the error repeats the timeout you
  set:** the network has an IPv6 route that carries no traffic (`curl -6 -I https://cdn.playwright.dev` hangs while
  `curl -4 -I https://cdn.playwright.dev` answers). Playwright tries IPv6 first for five seconds, and Node's default
  HTTP agent gives up on a socket that is still connecting after five seconds, so IPv4 is never tried; the connection
  timeout applies only once a socket has connected, which is why it cannot help. Repair or disable IPv6 on that network,
  or run the install once with the agent's timeout lifted: a Node preload file that sets
  `http.globalAgent.options.timeout` and `https.globalAgent.options.timeout` to `0`, passed with
  `NODE_OPTIONS=--import <file URL>` to `pnpm --filter @melarc/e2e exec playwright install chromium`. Keep that file
  outside the repository: it is a workaround for one network, not part of the setup.
- **Tests fail with timeouts, a Vitest worker does not start, or a step fails with a network error, in the middle of a
  long run:** check the machine did not go to sleep and is not busy with something else (a runaway background process
  is enough). Several suites have absolute start-up deadlines, so keep the machine awake and quiet for a full run, and
  re-run the step that failed before looking for a defect.

## Not provided yet

Seeded fixtures for the Local environment belong to the product slices that need them
([DEPLOYMENT_AND_ENVIRONMENTS.md](architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) sections 3 and 4); there is no product
data to seed yet. The capture adapter and the delivery worker exist (section 5) and the staff operations queue messages
for them, but no real email or SMS provider is built. Staging and production are not set up from here.
