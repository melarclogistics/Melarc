# SLICE-000 session handoff

Written for the next coding session. It says where SLICE-000 stands after S0.2, which batch is authorised next, and how to test. It holds no secret. Facts about code are in the code and the owning documents; this page points to them and does not restate them.

## 1. State

- **Branch:** `docs/slice-000-reconciliation`. **Nothing is pushed**; `origin/main` is `9c34b69`.
- **Commits on the branch, oldest first:**

| Commit | What |
|---|---|
| `449dfa1` | P0 reconciliation checkpoint (specifications, contract 5.77, regenerated client, the plan) |
| `cb5ce3e` | S0.1: the sixteen ports, tokens and the composition root |
| `a32211d` | S0.2: configuration, key material, the describe composition, the singleton rule, and the plan decisions of section 4 |
| the commit that adds this file | the handoff and its link from the root `CLAUDE.md` |

- **Working tree after those commits:** clean of tracked changes. Untracked and ignored: `tmp/` (scratch, source archives, logs), `apps/api/.env` and `infrastructure/postgres/.env` (the developer's, untouched and never committed).
- **Task state:** S0.1 and S0.2 are done. S0.3 and later are not started.

## 2. Completed scope (S0.2)

Configuration, key material and the describe composition, plus the corrections of 9 October 2026. The code is the record; the entry points are:

- `apps/api/src/platform/config/`: `load-config.ts` (the loader and its relations), `config-settings.ts`, `key-material.ts`, `secret.ts` (`Secret`: prints as `[REDACTED]`, only `reveal()` returns it), `origins.ts`, `trust-proxy.ts`, `adapter-refusals.ts` (what each environment refuses), `inert-config.ts`.
- `apps/api/src/platform/auth/describe/`: the sixteen inert `Describe*` adapters, the `DescribeAdapter` base, and `port-binding-check.ts`.
- `apps/api/src/app.module.ts`: the composition root. **Every port binding is an application singleton.** A request or transient lifetime is refused at registration, and the container's own record of each bound port is checked at `app.init()`, before listening, for effective scope (class metadata, aliases, injected dependencies) and, in the runtime composition, for an inert describe adapter. The check injects no port, so a scoped binding cannot stop another port being judged.
- `.env.example`, `scripts/setup-env.ts`, `e2e/harness/api-environment.ts`, and the table and "Deadlines" map in `architecture/DEPLOYMENT_AND_ENVIRONMENTS.md` §12.5, which `deployment-table.test.ts` ties to the code and to this plan.

**Validation is not enforcement.** The new settings are checked at start; nothing yet applies a limit, deadline or trusted-proxy value. Their numbers are provisional, configuration-validated defaults.

## 3. Verification evidence

- **Full gate, B + D + E, passed.** It ran uncached on Windows on the tree "`cb5ce3e` plus the S0.2 working tree" whose source archive is `tmp/melarc-source-cb5ce3e14d6e-modified-s0-2-corrected.zip` (SHA-256 `a0c17fee462e120ba5272e6a86ab2e687ef2df183dd63d3a8cc0bacbe8a92f81`). Results: `format:check`, `lint`, `typecheck`, `build`, `contract:check` (0 operations compared), `api-client:check`, `db:check` exit 0; `pnpm test` exit 0 (root 1187 passed / 2 skipped; API 2262 / 5; Ops 220; api-client 250; harness 199 / 1); `pnpm run test:db` exit 0 (170 passed, 1 skipped); `pnpm run test:e2e` exit 0 (16 passed).
- **That evidence predates the singleton rule and the plan decisions of section 4.** Those were verified afterwards, on the tree that became `a32211d`: the base set B again, uncached, all exit 0 (`format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check`, `db:check`, and `pnpm test` with root 1187 passed / 2 skipped, API 2286 / 5, Ops 220, api-client 250, harness 199 / 1), plus the focused composition, describe-adapter, architecture and configuration tests. `test:db` and `test:e2e` were **not** re-run: the changes touch the composition root and port-binding validation, which the real API start path does not exercise (the runtime composition binds no port yet), and the instruction was not to repeat them for these changes. Re-run them at the next stage boundary or on request.
- **Mutation checks** were run on the S0.2 logic (91 breaks in total, all caught) and one targeted break of the singleton check. They are not part of the routine; see section 8.
- **Skipped on Windows, by design:** five API process tests and one `test:db` test and one harness test (a real `SIGTERM`), the symlink test and the POSIX file-mode test (root). **Never run:** any Linux check.

## 4. Decisions recorded (plan §11.8, §10 rows 15 and 16, OB-36, OB-37)

- **S0.20** owns the HTTP header and body receipt limits and HTTP admission. They bound a slow sender and nothing a handler does.
- **S0.6** owns the database and resource deadlines and the **shared execution-budget mechanism**; **S0.20 integrates** that mechanism into the request pipeline (S0.20 now needs S0.6).
- **Database timeouts alone do not bound a whole request.**
- **Enforcing an execution budget is not racing a response against a timer.** It must cancel what can be cancelled, roll back the open transaction, discard a connection of uncertain state, and prevent or record a late side effect. This is **OB-37**, proved by S0.6 (mechanism) and S0.20 (pipeline), mid-work, on a second connection.
- **Concrete values are qualified at first use and calibrated in S0.65.** S0.2's numbers are provisional, configuration-validated defaults.
- **Managed key custody** (implementation, rotation proof, recovery proof) is a prerequisite of release gate **G3** (**OB-36**). Production stays refused until it exists; S0.2 builds none. Staging's local custody, capture adapter and substitute verifier are controlled fixture acceptance only, never real-provider, real-secret or release evidence, and extend no waiver.
- **Not implemented:** any future deadline task.

## 5. Outstanding obligations and their owners

| Obligation | Owner | State |
|---|---|---|
| OB-24 real `SIGTERM` tests on Linux (five API process, one `test:db`, one harness) and the worker's shutdown | before Gate 2 (S0.19) passes; S0.18 | not run; required, no waiver |
| OB-25 POSIX mode and Windows ACL inspection of custody files | S0.30 | not run; required |
| OB-26 JVM verifier build and tests on Linux or CI | S0.55 | not run; required |
| Bootstrap waivers (runbook items 4 to 7), only for the existing tests they name | each item's milestone | not extended by inference |
| OB-35 production handling of a metric label outside its bounded set | S0.15 | not built |
| OB-36 managed key custody | G3 | not built |
| OB-37 execution budget | S0.6, S0.20 | not built |
| OB-31 calibration of provisional and development-qualified values | S0.65 | not done |
| Release gates G1 to G5 | the exposure each names | none blocks the local walk |
| The esbuild moderate advisory GHSA-67mh-4wv8-2f99 (patched in 0.25.0 or later; reached only through the latest `drizzle-kit`) | the owner decides; no override applied | open |

Also open: the 7 October machine-compromise finding (do not create the local test CA, custody files or real credentials on this machine until it is resolved) and the owner-unconfirmed items listed in the plan's §10.

## 6. Next authorised batch: S0.3a to S0.3d only

Authorised: the four subtasks of **S0.3, Cryptography and credential normalisation** ([plan §5, S0.3](SLICE-000-IMPLEMENTATION-PLAN.md#s03--cryptography-and-credential-normalisation)). Run code **B** only. It needs S0.2, which is done. **Nothing else is authorised**: not S0.4, and no commit, push or dependency change unless the batch's instruction says so.

| Subtask | Builds |
|---|---|
| S0.3a | Qualify `crypto.argon2` on the pinned Node first; then `Hasher`, the credential rule and the email canonical form |
| S0.3b | `TokenService` (tokens, SHA-256 at rest, constant-time compare) and `randomUUIDv7` |
| S0.3c | `TotpVerifier` (RFC 6238, injected UTC clock, replay-step tracking) |
| S0.3d | `SecretCipher` (AES-GCM, purpose-separated keys, key version, rotation) |

**Where to work and what exists.**
- The ports to implement: `apps/api/src/platform/auth/ports/` (`hasher.port.ts`, `token-service.port.ts`, `totp-verifier.port.ts`, `secret-cipher.port.ts`, `clock.port.ts`). Read each descriptor: it states inputs, outputs, outcomes, raised errors and the transaction rule.
- Planned files: `apps/api/src/platform/auth/crypto/*`, `apps/api/src/platform/auth/credentials/*` and their tests; a single-hash benchmark script under `apps/api/src/tools/`.
- Key material arrives as `config.keys.purposes[<purpose>]` (`{ activeVersion, versions }`, each key a `Secret`); call `reveal()` only inside the adapter. The purposes are `totp_seed`, `credential_delivery`, `idempotent_replay`, `limiter_digest` and `password_pepper`; the pepper belongs to the `Hasher`.
- A new adapter is a `*.adapter.ts` file (or any file implementing a port). Add it to `ALLOWED_PORT_IMPLEMENTATIONS` in `apps/api/src/architecture.test.ts` and bind it in `app.module.ts` (a singleton, with no `scope`); only the composition root imports an adapter.
- Evidence the plan asks for: published known-answer vectors (RFC 6238, Argon2id), key-rotation tests (old version decrypts, new version encrypts), the U+FB03 arithmetic of the 12 and 128 code-point bounds, security-matrix Families V8 to V10. State reached: fixture/platform verified.

**Stop if** (plan S0.3 and §9): a published vector disagrees with the library; a new package is needed (`dependency-policy.test.ts` allows exact versions only and no install scripts, so a package is a stop condition); `crypto.argon2` is missing or unusable on Node 24.21.0; a key purpose needs a value the documents leave unset (surface it, never default it); the batch would touch unrelated work, a stable identifier or a contract. It does **not** claim production Argon2id parameters: S0.3a records a development-qualified cost with its environment, and S0.65 proposes deployment values.

## 7. Commands and environment constraints

- **Commands:** `pnpm run format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check`, `pnpm --filter @melarc/api run db:check`, `pnpm test`, `pnpm run test:db`, `pnpm run test:browser`, `pnpm run test:e2e`. A verifying run uses `TURBO_FORCE=true` because Turbo caches `test`. Share source only with `pnpm run package:source --out tmp/<name>.zip`.
- **Toolchain:** Windows 11; Node 24.21.0, pnpm 11.1.3, TypeScript 6.0.3 (pinned).
- **Local services are the developer's.** PostgreSQL is started with `pnpm run infra:up`. Do not start Docker, WSL or the database from the session; give the command. Linux checks are the developer's too (`.\tmp\linux-check.cmd`, git-ignored).
- **`apps/api/.env` predates S0.2** and lacks the required new settings, so the API will not start from it. The developer rebuilds or edits it (`pnpm run setup:env` names the missing settings). It was not touched.
- **Do not** run `prettier --write` on the prettier-ignored folders (`architecture/`, `contracts/`, `delivery/`, `design/`, `features/`, `registers/`, `standards/`, `surfaces/`, root `*.md`); edit them with exact, small edits.
- **Shell traps:** Bash mangles backslashes and backticks in `sed` and `node -e`; write scripts and multi-line edits with the file tools. A Nest dependency-injection error while the application is created calls `process.abort()`, so a startup check belongs at `app.init()`. `spawnSync` needs a large `maxBuffer` when a test run fails loudly. Never print, log or paste a credential value.
- **Git:** no reset, clean, mass formatting, push or deployment. Commit only when the instruction says so, with explicitly reviewed paths.

## 8. Testing policy

- **During implementation:** targeted checks only, the tests of the files being changed and the affected `format`, `lint` and `typecheck`.
- **At batch completion:** the consolidated checks the batch affects, as its plan block's run codes name them (for S0.3, the base set B). Report skips and unrun checks exactly.
- **At stage and merge boundaries:** the required full gates (B, and D, W, E, L, J where the stage's blocks list them), uncached. The next boundary is Gate 1 at S0.10.
- **No routine repeated mutation campaigns.** Break the real tree to prove a new guard only when the guard is new or its logic changes, and restore files by hash.
- A mandatory gate is never waived silently. If an instruction conflicts with one, report the conflict.
