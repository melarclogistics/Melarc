# Integrated harness (`e2e`)

A real browser, the built Ops Portal, the API process and a disposable PostgreSQL database, started once per run. Read [README.md](README.md) first. `pnpm run test:e2e` builds the API and Ops through Turbo and needs the local database and Chromium ([DEVELOPMENT.md](../DEVELOPMENT.md)); the harness itself only runs built applications and never builds them. What B0.7 left undone is in the runbook ([B0.7](../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b07)).

## Rules

- Add specs in `tests/`; do not rebuild the harness. Data comes from the deterministic fixtures, and the browser clock from `freezeBrowserClock`.
- The browser may reach the Ops origin and nothing else, and the API runs under an outbound guard. A slice that adds a provider (SMS, email, payment) adds its own sandbox or capture adapter and asserts on it. Never contact a real provider.
- Never create a context with `browser.newContext()`: it bypasses the browser boundary. Only the Chromium project and one worker are covered.
- A run removes only the database it made. Never add cross-run cleanup or delete a database on a guess; leftovers of a killed run are listed with `pnpm --filter @melarc/api run db:orphans`.
- The `/api/v1/e2e/*` routes and the `e2e_harness` table exist only for the harness's technical journey, in `apps/api/test/support/e2e-main.mjs` and `e2e/harness/database.ts`, never in `src/`. The first slice replaces them with real screens and operations.
- A failing run must keep its evidence (process logs, sandbox capture, traces). Never add retries or weaken an assertion to get green.

## Tests

`pnpm --filter @melarc/e2e test` runs the harness's own unit tests and needs neither a database nor a browser.
