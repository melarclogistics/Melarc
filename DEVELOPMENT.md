# Developer setup

How to get Melarc running on your machine and prove it works: from a clean checkout to the API, the Ops Portal and a
PostgreSQL database running locally, with the checks passing. The commands are the same on Windows (cmd, PowerShell
or Git Bash), WSL2 and Linux. `scripts/local-setup.test.ts` fails if this page names a command, script or file that
does not exist.

When you are done you have the database on `127.0.0.1:5432`, the API on `127.0.0.1:3000` and the Ops Portal dev
server proxying `/api/v1` to it. There are no product screens or business routes yet: the API serves its technical
probes and the Ops Portal is the application shell.

## Prerequisites

| You need | Version                                                          | Notes                                                                                                                                 |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Git      | any recent                                                       |                                                                                                                                       |
| Node.js  | **24.21.0**, the version in [.node-version](.node-version)       | Version managers such as fnm and nvm read that file. `pnpm install` refuses a Node outside `engines` in [package.json](package.json). |
| pnpm     | **11.1.3**, the `packageManager` in [package.json](package.json) | `npm install -g pnpm@11.1.3`                                                                                                          |
| Docker   | Docker Desktop, or Docker Engine with the Compose plugin         | Running before step 3. It only hosts the local PostgreSQL service.                                                                    |

## 1. Install dependencies

```text
pnpm install --frozen-lockfile
```

For the browser tests (step 6) install the Chromium that the pinned Playwright expects. On Linux and WSL2 add
`--with-deps` (it installs system packages with `sudo`); on Windows leave it out.

```text
pnpm --filter @melarc/e2e exec playwright install chromium
```

The browser tests run Chromium unless `MELARC_BROWSERS` names more. CI runs `chromium,firefox,webkit`, the engines of the
browsers the Ops Portal supports. To do the same on your machine, install the other two once and name them for the run
(this is `cmd`; in a POSIX shell use `export MELARC_BROWSERS=chromium,firefox,webkit`):

```text
pnpm --filter @melarc/e2e exec playwright install firefox webkit
set MELARC_BROWSERS=chromium,firefox,webkit
pnpm run test:browser
```

## 2. Create the local settings

```text
pnpm run setup:env
```

This creates two git-ignored files from their committed examples and prints no secret:

- `infrastructure/postgres/.env`: random, throwaway passwords for the database's three identities (the cluster
  superuser, the migration identity and the API's runtime identity), the host and the port.
- `apps/api/.env`: the API's settings, with `DATABASE_URL` using the runtime identity and the same password.

It never overwrites a file, so it is safe to run again. If an existing `apps/api/.env` has no readable `DATABASE_URL`
(an older copy of the example) or its password no longer matches the database settings, it says so by name; delete that
file and run the command again to have it rebuilt. The passwords are only ever used on your machine.

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

## 4. Build and migrate

```text
pnpm run build
pnpm --filter @melarc/api run db:bootstrap
pnpm --filter @melarc/api run db:migrate
```

The database tools run from the build, so build first. `db:bootstrap` creates the three roles and the `melarc_dev`
database; `db:migrate` applies the migrations in `apps/api/migrations` as the migration identity. Both are safe to
repeat.

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

`/readyz` answers ready only while the database is reachable. The Ops dev server prints its address (Vite's default,
`http://localhost:5173`) and forwards `/api/v1` to the API, so the browser only ever talks to its own origin.

## 6. Run the checks and the smoke tests

These are the checks CI runs ([ci.yml](.github/workflows/ci.yml)), which also runs `pnpm run build`,
`pnpm --filter @melarc/api run db:check` and `pnpm audit --audit-level high`.

| Command                                                        | Needs                          | Proves                                                                                    |
| -------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck` | nothing                        | formatting, lint, strict types                                                            |
| `pnpm test`                                                    | nothing running                | unit, component and process tests of every workspace, and the repository's tooling tests  |
| `pnpm run contract:check`, `pnpm run api-client:check`         | a build (step 4) for the first | the implemented operations (none yet) match the contract; the generated client is current |
| `pnpm run test:db`                                             | the database (step 3)          | migrations, roles, row-level security and connection handling against a real server       |
| `pnpm run test:browser`                                        | Chromium (step 1)              | the Ops shell and components in real browsers (Chromium; CI also runs Firefox and WebKit) |
| `pnpm run test:e2e`                                            | the database, Chromium, builds | a real browser, the API and a disposable database together                                |

```text
pnpm test
pnpm run test:db
pnpm run test:browser
pnpm run test:e2e
```

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

- **Windows.** Use the commands above in any shell. Five API tests (under `pnpm test`), one more under
  `pnpm run test:db` and one harness test need to receive `SIGTERM`, which Windows cannot deliver to a process, so they
  are skipped there and run on Linux, in WSL2 and in CI. A skipped test is not a pass: run the suite in WSL2 or Linux
  before relying on shutdown behaviour.
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
- **Port 3000 (the API) or 5173 (the Ops dev server) is taken** by another project. Set `HTTP_PORT` in
  `apps/api/.env`; for the Ops dev server copy `apps/ops-web/.env.example` to `apps/ops-web/.env` and set
  `OPS_API_PROXY_TARGET` to the API's new address. Vite moves itself to the next free port.
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

Seeded fixtures for the Local environment and capture adapters for email and SMS belong to the product slices that
need them ([DEPLOYMENT_AND_ENVIRONMENTS.md](architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) sections 3 and 4); there is
no product data to seed and no provider to capture yet. Staging and production are not set up from here.
