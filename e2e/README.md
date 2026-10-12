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

## The trusted HTTPS origin (S0.23): what exists, and what is blocked

The identity slice's cookies are `Secure`, which a plain-HTTP origin cannot prove in every engine, so the slice needs a
browser-facing HTTPS origin whose certificate a browser really validates (never `ignoreHTTPSErrors`). What is built so far
needs no key and no CA, and none of it has been run against a certificate this checkout made:

- `harness/tls-material.ts` is the policy for a directory of test certificates named by `MELARC_E2E_TLS_DIR`: outside the
  checkout wherever the path leads (links, junctions, other spellings and shares of the same folder are resolved and compared
  by identity), a self-signed CA that carries critical name constraints, a leaf that names `localhost` and `127.0.0.1` and was
  signed by that CA, both valid now and for at most 31 days, the leaf's key readable by its owner alone. The policy reads that
  the constraints exist and bind (from the certificate's own structure), not what they permit: that is what the generator asks
  `openssl` for. Its tests use invented facts, certificate-shaped bytes written by hand and the public roots Node carries.
- `harness/test-ca.ts` and `pnpm --filter @melarc/e2e run tls:generate <directory> [days]` make that directory with
  `openssl`: a P-256 CA constrained to `localhost` and `127.0.0.1`, one leaf it signs, the CA's key and serial file deleted at
  once, exactly three files left, nothing trusted anywhere, and the result judged by the policy above before it is handed back
  (a generation that does not pass, or leaves anything else, is removed). Its tests run it against a fake `openssl`. **Run it
  on a clean machine or in CI, not on the shared developer workstation** (the owner's ruling of 11 October 2026: the machine
  finding of 7 October 2026 is not resolved).
- **The evidence of a spec that shows a secret** (`harness/evidence-policy.ts`; the audit of 11 October 2026). Such a spec is
  named `<name>.secret.test.ts`, imports `test` from `harness/secret-test.ts`, and runs in the `chromium-secret` project, whose
  trace, video and screenshots are off; the ordinary project does not match it. An automatic fixture fails the test before it
  begins if a recorder is on after every `test.use`. Playwright 1.63 also writes a snapshot of the page, **as text**, into
  `error-context.md` for a failing test whatever the recorders say; the configuration turns that off for every test
  (`PLAYWRIGHT_NO_COPY_PROMPT`). `harness/secret-evidence.ts` reads the syntax of every file under `tests/` at any depth and
  refuses a declared secret in a file not named as one, and a secret spec that calls `.use`, takes `test` from Playwright, loads a
  module dynamically or names anything that attaches or records. `tests/evidence-policy.spec.ts` proves it on what Playwright
  writes: a failing synthetic spec under the real project definitions leaves no recording and no sentinel, an override of the
  recorders does not start, and the same spec under a bare configuration does leave the page as text (the control).
  `tests/evidence-canary.secret.test.ts` keeps the project from being empty. What it cannot do: keep a secret out of an
  assertion's message (compare hashes, lengths or booleans).

**Blocked until a CA exists, and reported blocked, never green:** the per-engine spike (how Chromium, Firefox, WebKit and a
branded Chrome and Edge are made to trust the CA in a disposable profile or environment, with a negative test that an untrusted
CA fails, recording per engine which mechanism works and what it proves); the HTTPS Ops origin in the stack (it serves plain
HTTP today, and only the Chromium project runs); every proof that needs a `Secure` cookie over HTTPS (`AC-SLICE-000-127`, the
cookie evidence of S0.25). A persistent machine-wide trust change is not authorized: it needs the owner's exact installation
and removal plan first. To unblock, on a clean machine or in CI, run `tls:generate` (its success is the first real evidence
that `openssl` accepts the arguments and the policy accepts the result), then the spike. The policy does not prove what the CA's
name constraints permit. Where the CA is made, before its key is deleted, the proof that it refuses a name outside the loopback is
`openssl verify`: sign a second leaf for `DNS:example.com` with the same CA and run `openssl verify -CAfile ca.pem outside.pem`,
which must fail with a permitted-subtree violation, and `openssl verify -CAfile ca.pem -verify_hostname localhost leaf.pem`, which
must pass. Those commands and their output are the evidence, and have not been run on this machine.
