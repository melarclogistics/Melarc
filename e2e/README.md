# @melarc/e2e: the integrated test harness

A real browser, the Ops build, the API process and a disposable PostgreSQL database, started once per run and
torn down after it. Specs add integrated acceptance tests on top of it without rebuilding any of this.

```text
pnpm run build        # the harness runs the built applications, never a build of its own
pnpm run test:e2e     # needs a PostgreSQL service (infrastructure/postgres, or CI's) and Chromium
pnpm run test:e2e:https   # Linux in CI, or a machine cleared for key material: makes a test CA, runs Chromium, Firefox and WebKit over HTTPS
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

## The trusted HTTPS origin (S0.23)

The identity slice's cookies are `Secure`, which a plain-HTTP origin cannot prove in every engine, so the slice needs a browser-facing
HTTPS origin whose certificate a browser really validates (never `ignoreHTTPSErrors`). **Everything below is built and its logic is
tested without a certificate, because no test CA may be made on the shared developer workstation (the owner's ruling of 11 October
2026). The first hosted run (12 October 2026) was the first time any of it met a real certificate and browser: 22 of its 33 tests
passed, and the failures included every WebKit test that needs the CA trusted, because WebKit ignores `SSL_CERT_FILE` (its trust is
now the system store of a GitHub-hosted runner, below; the plan, §7.21, has the record). S0.23 is not complete until a hosted run
passes in full.**

- `harness/tls-material.ts` is the policy for a directory of test certificates named by `MELARC_E2E_TLS_DIR`: outside the
  checkout wherever the path leads (links, junctions, other spellings and shares of the same folder are resolved and compared
  by identity), a self-signed CA that carries critical name constraints, a leaf that names `localhost` and `127.0.0.1` and was
  signed by that CA, both valid now and for at most 31 days, the leaf's key readable by its owner alone. The policy reads that
  the constraints exist and bind (from the certificate's own structure), not what they permit.
- `harness/test-ca.ts` and `pnpm --filter @melarc/e2e run tls:generate <directory> [days]` make that directory with `openssl`: a
  P-256 CA constrained to `localhost` and `127.0.0.1`, one leaf it signs, exactly three files left, nothing trusted anywhere, and the
  result judged by the policy above before it is handed back. **Before the CA's key is deleted, `openssl verify` proves the
  constraints bind**: the leaf verifies for `localhost` and for `127.0.0.1`, and a second leaf for `example.com`, signed by the same CA
  and the same key, does **not** (it must fail with a permitted subtree violation; a refusal for any other reason does not count). A
  CA that does not refuse the outside name is removed. Its tests run against a fake `openssl`. **Run it on a clean machine or in CI,
  not on the shared developer workstation.**
- `harness/https-front.ts` is the stand-in for the production edge: a TLS-terminating reverse proxy (TLS 1.2 as the floor) in front
  of the Ops origin. It adds the response headers a browser surface needs (a content security policy that is the shell's tested
  baseline, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS; `GBT-W9`) and forwards everything else,
  `Set-Cookie` included, unchanged. The API is configured with its exact origin (`OPS_ORIGIN`), so its CSRF and CORS judgements are
  made against the origin the browser really sends. The values of its headers are the harness's own; the production edge's are
  release gate G2.
- `harness/engine-trust.ts` plans, and makes, a store of its own for Chromium and Firefox below the TLS directory, in the run's
  directory only, holding the CA certificate and nothing else. WebKit has no store of its own to be given (below): **on a
  GitHub-hosted runner alone**, `harness/system-trust.ts` puts the CA in the system store for WebKit's proofs and takes it out when they
  end. Nothing else of the machine, the user or the system is changed:

  | Engine                 | Mechanism                                                                                                                                         | Basis                                                                                                                                                                                                                                                                                               |
  | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Chromium               | the NSS database of a home directory made for the run (`certutil`; `HOME` set for the browser process only)                                       | documented behaviour of Chromium on Linux                                                                                                                                                                                                                                                           |
  | Firefox                | a profile seeded with the CA in `cert9.db` (`certutil`), kept as a template and copied for each test, from which a persistent context is launched | documented behaviour of Firefox                                                                                                                                                                                                                                                                     |
  | WebKit                 | the system trust store of a GitHub-hosted runner (`sudo` and `update-ca-certificates`, for WebKit's proofs only, taken out when they end)         | WebKit's TLS library (libsoup over glib-networking's GnuTLS backend) reads the system's trust list and no environment variable: the first hosted run showed `SSL_CERT_FILE` ignored. The owner's decision of 12 October 2026. On any other machine WebKit has no disposable form and fails to trust |
  | Chrome, Edge (branded) | as Chromium                                                                                                                                       | a smoke check by a person (below)                                                                                                                                                                                                                                                                   |

  On Windows and macOS Chromium, Chrome and Edge use the operating system's store, which has no disposable form, so there is no
  automated HTTPS run there; a persistent machine-wide trust change needs the owner's exact installation and removal plan first.

- `harness/https-test.ts` (and `harness/https/secret-test.ts` for a spec that shows a secret) is the test the HTTPS specs import: the
  browser may reach the HTTPS origin and nothing else, Firefox is launched from a private copy of its seeded profile that is made for
  each test and removed when it ends (`harness/fresh-profile.ts`; the seed is a template that nothing is launched from, because a
  persistent context keeps what a page stores), and **without test certificates a spec is skipped with the reason on a developer
  machine and fails in CI**, so a run that did not make the proofs is never green.
- `tests/https-trust.spec.ts` is the **per-engine spike**: the Ops shell loads over HTTPS with the certificate validated, and a
  browser of the same engine without the mechanism (launched in an environment of its own, given explicitly: an empty disposable home, no
  variable that names a store and none of the harness's own, `harness/untrusted-browser.ts`; **Playwright merges a project's launch
  defaults under any option that is left out**, so deleting `env` from a copy of the project's options brings the trusted environment
  back, which is how Chromium loaded the origin it must refuse in the first hosted run) refuses the same origin **with that engine's own certificate diagnostic**
  (`harness/trust-failure.ts`: a timeout, a name or connection that did not work, a blocked request, a crash and a closed page are not
  evidence, and a signature that is not on its list fails the test to be diagnosed, never accepted), beside a probe showing that the
  endpoint is up and its leaf validates against the CA for a client that trusts that CA (`harness/https-probe.ts`); each test attaches
  the mechanism, the browser version and what it proves. WebKit's only trust is the system store, so its browser "without the
  mechanism" exists only before the CA is put there: its refusal is the test tagged `@untrusted-control`, run first in a project of its
  own (`https-webkit-control`) while the store lacks the CA, and WebKit's other proofs run after (`https-webkit`,
  `https-webkit-secret`). `tests/https-isolation.spec.ts` shows on the real fixture that one test's
  persistent cookie and local storage are not there in the next, and that the CA is still trusted. `tests/https-headers.spec.ts` shows the edge headers on
  the page and on an API response (`GBT-W9`) and the API's `Cache-Control: no-store` (`GBT-W8`). `tests/https-cookies.secret.test.ts`
  shows that each engine stores the product's session cookies as set (`Secure`, host-only, `Path=/`, `SameSite=Lax`, `HttpOnly` for
  the session only), lets script read the CSRF token and not the session cookie, sends both back, rotates the credential at each
  issue and expires both (`GBT-W13`). `tests/https-origin.secret.test.ts` shows what each engine really sends that the CSRF guard of S0.25
  judges: the exact `Origin`, `Sec-Fetch-Site: same-origin`, the cookies and the token header, on a same-origin `fetch`. These use
  the harness's technical routes (`/api/v1/e2e/cookies/*`, `/api/v1/e2e/echo`), which exist only in the test entry point, so they
  are **fixture/platform evidence** and say nothing of a real sign-in.
- **The command is `pnpm run test:e2e:https`** (`harness/https-run.ts`): it makes a private directory outside the checkout, makes the
  CA in it, and runs the HTTPS projects with `MELARC_E2E_TLS_DIR` naming it in **two runs**: first Chromium, Firefox and WebKit's
  refusal, then, with the CA put in the system store of a GitHub-hosted runner, WebKit's other proofs. It takes the CA out of the
  system store and removes the directory in a `finally` whatever happened, runs both whatever the first did, and exits with the first
  failure. Each run says its exit status when it ends, and the command ends with a summary of every run and of the one the overall
  status comes from. Each run writes to an output directory of its own below `test-results` (`--output`), because Playwright clears the
  output directory of the projects it runs at the start of a run, and the failure artifact of CI keeps `e2e/test-results`; the recorders
  of the secret projects are unchanged. Where the system store may not be changed (anywhere but a GitHub-hosted runner) the second run
  is made without it, says so, and WebKit's proofs fail to trust. It is a mandatory step of CI (`integrated`, after `pnpm run test:e2e`, with `libnss3-tools`
  installed for `certutil`). **It refuses on Windows and macOS, and on Linux outside CI unless the person running it
  has declared the machine cleared for key material (`MELARC_E2E_KEYS_CLEARED=1`).** `pnpm run test:e2e` runs the plain projects
  (`chromium`, `chromium-secret`) only.
- **A smoke check in branded Chrome and Edge** is a person's, on a machine cleared for key material (a clean Linux machine or
  virtual machine with `google-chrome` and `microsoft-edge` installed, and `libnss3-tools`): run `pnpm --filter @melarc/e2e run
tls:generate <a directory outside the checkout>`, then, with `MELARC_E2E_TLS_DIR` set to it and `CERTUTIL`/`OPENSSL` if needed,
  `pnpm run build` and `pnpm --filter @melarc/e2e exec playwright test --project=https-chrome --project=https-msedge`, and keep the
  attached `trust-mechanism` evidence; delete the directory afterwards. No repository command runs these two projects.
- **The evidence of a spec that shows a secret** (`harness/evidence-policy.ts`; the audit of 11 October 2026). Such a spec is
  named `<name>.secret.test.ts`, imports `test` from a `secret-test.ts` (`harness/secret-test.ts`, or `harness/https/secret-test.ts`
  for the HTTPS origin), and runs in a `-secret` project, whose trace, video and screenshots are off; the ordinary project does not
  match it. An automatic fixture fails the test before it begins if a recorder is on after every `test.use`. Playwright 1.63 also
  writes a snapshot of the page, **as text**, into `error-context.md` for a failing test whatever the recorders say; the
  configuration turns that off for every test (`PLAYWRIGHT_NO_COPY_PROMPT`). `harness/secret-evidence.ts` reads the syntax of every
  file under `tests/` at any depth and refuses a declared secret in a file not named as one, and a secret spec that calls `.use`,
  takes `test` from Playwright, loads a module dynamically or names anything that attaches or records.
  `tests/evidence-policy.spec.ts` proves it on what Playwright writes: a failing synthetic spec under the real project definitions
  leaves no recording and no sentinel, an override of the recorders does not start, and the same spec under a bare configuration does
  leave the page as text (the control). `tests/evidence-canary.secret.test.ts` keeps the project from being empty. What it cannot do:
  keep a secret out of an assertion's message (compare hashes, lengths or booleans).

**What is still blocked, and reported blocked, never green:** every proof above in a real browser, until the first run in CI or on a
cleared machine passes (`pnpm run test:e2e:https` is the first real evidence that `openssl` accepts the generator's arguments, that
`certutil` seeds the stores, and that each engine trusts the CA by its mechanism: the first hosted run showed WebKit's first candidate
does not work, and its replacement, the system store of a GitHub-hosted runner, is shown by the next); the
branded Chrome and Edge smoke check; any HTTPS run on Windows or macOS; and the sign-in, MFA, revocation and rotation proofs of
`AC-SLICE-000-127` and `GBT-W13` over a real sign-in, which need operations that are not built. The generator's name-constraint proof
and the leaf's validation by each engine are claims about software this repository does not control: they are shown by the run, not by
the policy.
