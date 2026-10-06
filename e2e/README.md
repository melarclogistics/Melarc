# @melarc/e2e: the integrated test harness

A real browser, the Ops build, the API process and a disposable PostgreSQL database, started once per run and
torn down after it. Specs add integrated acceptance tests on top of it without rebuilding any of this.

```text
pnpm run build        # the harness runs the built applications, never a build of its own
pnpm run test:e2e     # needs a PostgreSQL service (infrastructure/postgres, or CI's) and Chromium
pnpm --filter @melarc/e2e test   # the harness's own tests; no database or browser needed
```

- Browser requests go to the Ops origin, which proxies `/api/v1` to the API, as the production edge does. The
  browser can reach that origin and nothing else, compared as a parsed origin (scheme, host and port), not as text:
  any other request in any page of the context, a popup's included, and any other WebSocket is aborted and
  recorded (`sandbox.externalBrowserRequests()`). Service workers are blocked.
- The API runs under an outbound guard: any connection to something other than this machine is refused and
  recorded, so a test can assert on an external effect the code tried to have (`sandbox.outboundAttempts()`).
- Data comes from `fixtures` (seeded by the test's title) and the browser clock from `freezeBrowserClock`.
- When a test fails, the logs of every process, the sandbox capture, a database summary and a description of
  the stack (passwords hidden) are attached to the report.
- A run removes only the database it made, and ends only the processes it started; a stop that cannot confirm a
  process ended fails and names it. Harnesses can share a PostgreSQL server: nothing removes another run's
  database. A run that was killed leaves its database behind; list them with
  `pnpm --filter @melarc/api db:orphans` and remove one by name with `db:orphans --drop <name>`.
