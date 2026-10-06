# Melarc bootstrap and design-system audit

**Date:** 5 October 2026 (UTC)  
**Authoritative input:** `Melarc(8).zip`  
**Scope:** B0.1–B0.9, prior remediation, developer/CI readiness, and all three design documents  
**Overall verdict:** **FIX REQUIRED — retain the foundation; do not declare B0.10 acceptance or begin UI integration yet.**

## 1. Decision for the owner

The project has a substantial, functioning engineering foundation. This audit does not recommend rebuilding it, introducing another governance framework, or expanding bootstrap into a full enterprise platform.

Independent Linux verification passed 1,900 tests with zero skips in the executed suites. Installation, formatting, lint, types, build, client freshness, contract checking and migration-history checking passed. The dependency audit passed its high/critical threshold and reported one moderate advisory. The previous database-URL, browser-client, schema-comparison, response-status, validation-path and browser-origin repairs are present, with extensive regression tests.

However, two independently reproduced tooling defects remain: a child-process error can masquerade as a confirmed exit, and the build-manifest verifier can accept an empty manifest for a nonexistent build. Developer setup also contains an overgeneralized WSL networking instruction. The uploaded archive still includes populated local credential files.

The design documents are thoughtful drafts with a suitable small initial scope. They are not yet an implementation-ready contract: they need specific corrections around authenticated versus pre-authentication layouts, permitted color pairings, implementation inventory, accessibility acceptance, state/error behavior and asset/token ownership. The nine published contrast examples were independently recalculated and are accurate.

**Recommended next sequence:** repair the two tooling defects; correct setup/archive hygiene; complete actual CI and clean-environment evidence; reconcile the design documents; then implement tokens and existing-shell styling in a small, separately reviewed UI task. Product work starts through the existing B0.10 acceptance and SLICE-000 sequence.

“Green” must mean the stated checks passed against the intended source and environment. It does not mean every eventual product behavior, browser, deployment or security control already exists.

## 2. Baseline and preservation

| Item | Observed baseline |
|---|---|
| Latest archive | `Melarc(8).zip` |
| Latest archive SHA-256 | `90590e4a676dbfb605af26db809e4bba6b8a788d10ff128276db7e857ef88211` |
| Earlier archive used during this audit | `Melarc(7).zip`, SHA-256 `61d708f626059d9b5d916db6ab11a623241c79a61ec723b037e6e42ad8a3d464` |
| Separately supplied design archive | `design.zip`, SHA-256 `efebb4b0c9ac1d93c486e44b5ffa391cc129b513c6e65d2f86c22bd45cdbeac2` |
| Git HEAD | `5c71c8706c4cad3414b75527dcc2d0f647c458f9` |
| Git state | Bootstrap implementation remains uncommitted; retained specifications have tracked edits; implementation/tooling paths are untracked; nothing staged |
| Runtime used for verification | Node 24.21.0; pnpm 11.1.3; Linux |
| Canonical API | 172 operations, 172 unique operation IDs, 171 schemas |
| Current contract SHA-256 | `96f598e171146e6973a015e18affcbff7b08f66b0688deb9e946f55eb376ac60` |
| Preservation check | 366 source/support files compared byte-for-byte with latest ZIP; zero changed or missing |
| Relative Markdown file links | 1,145 checked; zero missing file targets |

The link scan checks inline relative file targets, not every fragment, external URL or reference-style link. It is not a claim that all prose is semantically current.

`Melarc(8).zip` differs from the tested `Melarc(7).zip` only by adding `design/BRAND_FOUNDATION.md`, `design/DESIGN_SYSTEM.md`, `design/COMPONENT_PATTERNS.md`, and updating `.prettierignore`, `DEVELOPMENT.md` and seven `CLAUDE.md` guidance files. The three design documents are byte-identical to `design.zip`. Application code, tests, dependencies, lockfile, contract and CI workflow are unchanged between those two project archives.

Accordingly, unchanged-code test evidence was carried forward. A fresh frozen install, all 353 root tests and formatting were rerun against archive 8. No project source was edited. Dependencies/build output were created only in audit checkouts. No commit, staging, push, reset, database deletion or deployment occurred.

## 3. Independent verification

| Check | Result | Meaning and limitation |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | Fresh dependency installation; repeated successfully on archive 8 |
| `pnpm run format:check` | PASS | Includes latest configured scope; specification/design directories are deliberately excluded by `.prettierignore` |
| `pnpm run lint` | PASS | No lint failures in the implementation baseline |
| `pnpm run typecheck` | PASS | Root and workspace type checks |
| `pnpm run build` | PASS | API and Ops build successfully |
| `pnpm run api-client:check` | PASS | Generated client matches current contract |
| `pnpm run contract:check` | PASS | Current implemented business-operation scope is empty; this does not certify implementation of all 172 operations |
| `pnpm --filter @melarc/api run db:check` | PASS | Migration-history structure check, not a live database migration |
| `pnpm test` | PASS | 1,900 tests; zero skipped in executed Linux suites |
| `pnpm audit --audit-level high` | PASS with advisory | One moderate finding; no high/critical failure in this run |
| Prepare every canonical operation through `ContractValidator` | PASS | All 172 prepare; compilation alone does not prove every schema is satisfiable |
| Exact Playwright browser installation | BLOCKED | Pinned Chromium download repeatedly produced an invalid/truncated ZIP in this environment |
| `test:browser` | NOT independently executed | Exact browser installation did not complete; no browser substitution used |
| `test:db` | NOT independently executed | No configured PostgreSQL/Docker service in the audit environment |
| `test:e2e` | NOT independently executed | Requires both PostgreSQL and the exact browser |
| Hosted GitHub workflow and branch rule | NOT verified | No hosted run or repository settings evidence supplied |

Executed test counts:

| Suite | Passed | Skipped |
|---|---:|---:|
| Root tooling | 353 | 0 |
| API unit/process | 1,082 | 0 |
| Ops component/build/proxy | 114 | 0 |
| API client | 214 | 0 |
| Integration-harness unit/process | 137 | 0 |
| **Total** | **1,900** | **0** |

The final per-workspace summaries were read from Turbo's workspace logs as well as the root-command log. The Linux run closes the five API and one harness Windows-skip gaps for these executed suites. It does not close the separate database SIGTERM test gap.

The runbook reports Windows database tests at 140 passed/1 skipped, browser smoke at 7 and integrated tests at 16. Those remain **reported evidence**, not independent results of this audit. The runbook's root count of 318 is older than the current 353-test baseline; update any completion summary that presents it as current.

## 4. Bootstrap assessment by gate

| Gate | Assessment |
|---|---|
| B0.1 workspace/tooling | Sound baseline: pins, frozen installation, strict types, workspace tasks and generated-file discipline work. No dependency upgrade required by this review. |
| B0.2 API | Current unit/process suite passes on Linux, including shutdown cases. Config validation, deny-by-default routes, safe errors/logging and readiness/shutdown boundaries are present. Technical probes are not business operations. |
| B0.3 Ops shell | Real React/Vite shell with focus, landmarks, safe fallback and proxy tests. It remains neutrally styled and has no product screens. Browser execution is not independently repeated here. |
| B0.4 PostgreSQL/Drizzle | Separate identities, one migration history, transaction-local context and posture checks are present. Earlier query-override defect is repaired. Live migrations/RLS/teardown still require latest database evidence. |
| B0.5 generated client | Restricted browser transport, final-send checks, same-origin/CSRF constraints and freshness pass. First feature must adapt returned API errors for TanStack Query. |
| B0.6 conformance | Earlier false negatives addressed; all schemas prepare and tests pass. Empty implemented scope is truthful. Documented limits remain relevant for each first real operation. |
| B0.7 integrated harness | Origin checks and explicit orphan cleanup improved substantially. Process-error false-exit defect remains. Technical fixture journey is not a real product journey. |
| B0.8 CI | Workflow is well structured and locally tested. Manifest verifier needs repair. Hosted workflow execution, failure rehearsal, artifact verification and branch protection are outstanding. |
| B0.9 setup | Reproducible settings generation and committed commands exist. WSL instructions need qualification. Fresh infrastructure start/stop/full disposable reset were not proven by the submitted completion notes. |
| B0.10 acceptance | Still required by the retained plan. This audit supplies evidence and findings; it does not substitute for the missing integration/environment checks. |

### Positive engineering decisions to preserve

- Modular monolith, not premature microservices or additional infrastructure.
- Contract-generated wire types and separate browser/native authentication transports.
- Runtime database identity separate from migration/owner roles; transaction-local security context.
- No fake business routes or invented authenticated UI.
- Explicit orphan cleanup, unique test databases and negative isolation tests.
- Read-only GitHub token, action references pinned to SHAs, bounded jobs, and one aggregate result that fails for unsuccessful mandatory jobs.
- CI artifacts explicitly described as build output, not a deployable/signed release package.
- Narrow design-system scope; native Android shares semantics rather than web components.

## 5. Confirmed bootstrap findings

### B-01 — A child-process error is still treated as proof of termination

**Priority:** P1 for truthful teardown. **Status:** reproduced with a controlled child-event fixture.

**Location:** `e2e/harness/managed-process.ts`, constructor's `child.once('error', ...)`, approximately lines 113–117.

The error listener unconditionally sets `ended = true`, removes the instance from `running`, resolves the exit promise and labels the event a failure to start. That is valid for a confirmed spawn failure, but a Node `ChildProcess` can also emit `error` when signalling an already-running process fails. Such an error is not an exit.

An external audit probe instantiated the unchanged class with a child-event fixture whose SIGTERM attempt emitted `error` with `code: EPERM`, returned false, and never emitted `exit`. Result:

```json
{"outcome":"resolved","reportedExited":true,"signals":["SIGTERM"],"exitEventEmitted":false}
```

This is a deterministic lifecycle counterexample, not a claim that the operating system produced EPERM during a real test run. Node's documented error semantics support the scenario. The current implementation can report success and drop tracking while the child still owns resources.

**Repair:** distinguish failure to spawn from errors after successful spawn; preserve ownership/tracking until actual termination is confirmed; handle signal errors without resolving the exit promise; continue bounded cleanup or report failure. Keep ordinary spawn-failure handling. Ensure a failed stop remains available to later cleanup.

**Acceptance:** post-spawn signal-error/no-exit case must reject rather than succeed; later real exit must be recognized; spawn failure, graceful exit, forced exit and exhausted-deadline cases still pass. Test both `stop()` and `stopAll()` behavior. Do not solve this by raising timeouts.

### B-02 — Build verification can pass with no build and no files

**Priority:** P2; fix before relying on artifact verification. **Status:** reproduced through the public CLI function.

**Location:** `scripts/ci-revision.ts`, `readManifest`, `verifyManifest` and `runRevision('verify')`.

The reader accepts an empty `files` array. Verification ignores a missing root and therefore has nothing to compare. This malformed manifest was accepted in a temporary directory:

```json
{"schema":1,"source":{"revision":"not-a-real-revision"},"roots":["missing-build-root"],"files":[]}
```

Observed output and exit:

```text
Verified 0 files against revision not-a-real-revision.
exit 0
```

This contradicts the module's stated fail-closed behavior. The normal generator refuses empty roots, so this does not prove the current upload step generates such a manifest. It proves the consumer verification command cannot be relied upon for malformed input.

**Repair:** reject empty file sets, nonexistent/empty required roots, malformed hashes/revision fields, duplicate or out-of-root paths, and inconsistent manifest structure. Reuse path normalization during reading/verification. Either verify the manifest's claimed checkout/input identity or clearly label the command as file-content verification and document the separate source/run checks. Do not claim checksum matching authenticates an artifact or proves CI succeeded.

**Acceptance:** normal generated manifest passes; changed/missing/extra files fail; empty manifest, nonexistent root and malformed metadata fail. Keep artifact authorization based on the actual successful CI run and intended revision.

### B-03 — WSL setup assumes localhost connectivity that is not universal

**Priority:** P2 for B0.9 portability. **Status:** documentation defect verified against Microsoft's networking guidance.

**Location:** `DEVELOPMENT.md`, “Windows, WSL2 and Linux”.

The document says WSL2 reaches a Windows-hosted database at `127.0.0.1:5432` without qualification. WSL networking mode and Docker Desktop configuration matter. Default NAT and mirrored mode do not have identical host-access behavior. A setup that worked on the owner's machine is not sufficient proof of the unconditional statement.

**Repair:** name and test the supported topology. For example, document the required mirrored-mode/Docker setup for localhost access, or a separately verified Linux-local service arrangement. Include a non-destructive connectivity check and useful diagnosis. Do not weaken `assertLocalHost` or bind PostgreSQL to all interfaces merely to make the instruction work.

Also correct two related setup statements:

- A volume reset is the documented simple disposable-data procedure, not the only possible way PostgreSQL passwords can ever be changed. Avoid telling developers that password rotation inherently requires deleting all local data.
- A longer Playwright connection timeout is generic troubleshooting, not the demonstrated fix for the owner's previously diagnosed IPv6/agent-timeout failure. Keep the distinction explicit; avoid making a clean setup depend on ignored `tmp/` helpers.

### B-04 — Review archives still contain populated credentials and dependencies

**Priority:** P2 for artifact hygiene. **Status:** observed in latest upload; values not reproduced.

Both `apps/api/.env` and `infrastructure/postgres/.env` are present. The latter has populated administrator, migration and runtime password settings; the API file has a populated `DATABASE_URL`. The project ZIP also carries dependencies and generated/cache material.

`.gitignore` protects Git operations, not arbitrary ZIP creation. This is not proof of a Git secret commit or outside compromise.

**Repair:** use a repeatable source-review packaging command that excludes local `.env` files, dependency directories, caches and transient output while preserving `.env.example`, source, migrations, lockfile, specifications and intentionally supplied Git context. Do not delete the owner's local settings as cleanup. If credentials were distributed outside intended trusted recipients, assess replacement; do not print them in reports or logs.

### B-05 — CI/setup acceptance is incomplete, not a code failure

**Classification:** evidence blocker, separate from defects.

The runbook explicitly says the workflow has never run on GitHub, its manual failure rehearsal has not run there, branch protection must still be configured, and infrastructure start/stop from a fresh environment was not exercised. Those are legitimate remaining tasks, but they prevent a blanket “everything is green” verdict.

Required closure evidence:

1. A hosted CI run for the intended committed revision: all five mandatory jobs and `CI result` succeed.
2. The deliberate failure rehearsal makes both its job and aggregate result fail.
3. The actual repository rule requires `CI result` from GitHub Actions; define the team's permitted bypass behavior deliberately.
4. A downloaded build's content verifies against its recorded revision; the run and branch are checked separately. Include the B-02 negative case.
5. A clean supported Windows/WSL/Linux setup follows committed instructions for infrastructure start, settings, migrations, API readiness, Ops proxy, tests and safe stop.
6. Disposable reset is tested only in a deliberately disposable environment, not against valuable developer data.
7. Latest database, exact-browser and integrated suites pass; account for the additional database POSIX-only test.

This audit did not commit or publish the working tree to obtain those results. A ZIP working-tree pass must not be attributed to HEAD, because HEAD does not contain the bootstrap implementation.

## 6. Prior audit remediation: closure and residual scope

| Prior issue | Current assessment |
|---|---|
| F01 query-string identity mismatch | Repaired: URL query/fragment refusal, shared interpretation, explicit driver connection settings rather than reparsing the raw URL. Deployment TLS policy remains future work. |
| F02 client transport overrides | Repaired: restricted public methods/options and final-send checks. Caller cannot attach arbitrary middleware to the returned client. This is API discipline, not a sandbox against malicious same-origin JavaScript. |
| F03 comparator false negatives | Repaired for the demonstrated cases: repeated `oneOf`, absent versus `const: null`, effective parameter serialization. Operation-level servers now compared. |
| F04 wrong response status | Repaired: actual response status inspected after handler execution; unsupported response-takeover decorators fail startup. Header values and cookie declarations are checked. |
| F05 dynamic key leakage | Repaired: schema-aware pointer ownership masks data-owned keys. |
| F06 URL-prefix browser isolation | Repaired: parsed-origin checks at browser-context scope, WebSocket handling and blocked service workers. Full browser execution not repeated here. |
| F07 cross-run orphan sweeping | Repaired: explicit named deletion, listing default and deliberate disconnect option. Current-run cleanup remains. |
| Truthful process stop | Partially repaired; B-01 remains because error events still resolve termination. |
| C01 CollectionRecord | Repaired with a closed explicit response object; creation schema remains closed. Regression tests check the repeated fields. |
| C02 OpenAPI nullability | Legacy 58 `nullable: true` occurrences normalized. Two enum-bearing fields also admit null as documented, which is a real acceptance change and is disclosed in the runbook. |
| C03 Rider server count | Corrected to eight; all eight declarations retained; comparator support added. |
| Cache-Control | Required `const: no-store` on the approved four responses through the shared component/two inline definitions. |
| Sign-out cookie declaration | Browser-only condition and both cookie names declared; vendor device cookie preserved. Expiration and server revocation still require real identity integration tests. |

The canonical contract is intentionally changed from the earlier audit; it is no longer correct to describe it as byte-identical to the original hash. Its operation/ID/schema counts remain 172/172/171. Reviewed structural changes align with the approved repairs.

A separate probe confirms a documented limitation: `signOut` validation accepts fresh cookies with the correct names/attributes as well as expired cookies. The validator does not inspect expiry semantics. The runbook acknowledges this explicitly, so it is not a newly concealed defect. Before identity acceptance, test that the actual response expires both browser cookies and the old session cannot be used again.

Other declared limits should stay visible: exception-filter response validation, request coercion not transforming handler inputs, security-scheme registration and metadata on the first real operation, and no current business operation coverage. Do not add dummy operations merely to make the coverage count nonzero.

## 7. Design-system audit

### 7.1 What is strong

All three documents were read in full. Together they preserve the approved professional/trustworthy/modern/premium direction, Crimson + Ink palette and balanced density. They separate brand identity from domain semantics, preserve the actual logo rather than inventing a replacement, use semantic tokens, keep native Android independent of web components, and defer unnecessary grids/dialog frameworks/toasts.

Technology neutrality is appropriate: the current app uses ordinary CSS and has neither Tailwind nor Radix installed. Brand approval should not silently trigger a framework migration. Light-first is reasonable. The documents correctly distinguish proposed values from completed implementation.

The design work is **a useful draft**, not yet proof of a consistent implemented UI or accessibility conformance. There is no universal “enterprise standards” certification for a palette/component list. The relevant assessment is accessibility, coherent behavior, contract alignment, maintainability, testability and deployment compatibility.

### D-01 — Separate the existing frame from the authenticated shell

**Priority:** required before UI integration.

`COMPONENT_PATTERNS.md` §12 describes ApplicationFrame with PrimaryNavigation and TopContextArea. `DESIGN_SYSTEM.md` §13 similarly recommends a navigation shell. Both need an explicit distinction from the existing `src/app/AppFrame.tsx`, whose neutral frame has a skip link, banner and main landmark with no session/navigation.

`surfaces/ops-portal.md` §7 requires pre-authentication MFA to show no signed-in shell, navigation, user menu or data; credential setup says “No application shell”. A generic restyle must not add an Ink sidebar around every route.

**Correction:** define neutral/public frame, authenticated Ops shell and any shell-free setup layout separately. Keep the current structural component where appropriate. Specify which route family owns each layout and preserve route-change focus, skip link and landmarks. Resolve whether a minimal brand identifier is allowed on the shell-free setup surface without silently interpreting it as full navigation.

**Acceptance:** pre-authentication pages never display authenticated affordances, including during loading/challenge/error states. Session-only UI is not rendered on a 202 MFA challenge.

### D-02 — Define safe pairings, not only independent token colors

**Priority:** required before encoding tokens.

The nine contrast ratios in `DESIGN_SYSTEM.md` §4.5 are correct to the stated precision. That does not make every combination of the listed tokens accessible.

| Proposed combination | Recalculated contrast | Implication |
|---|---:|---|
| Primary crimson `#B4232E` / white | 6.52:1 | Suitable normal-text pair |
| Muted `#667085` / selected `#FCEBED` | **4.32:1** | Below 4.5:1 for normal text; restrict this pairing or supply a stronger selected-text token |
| Control border `#8A94A6` / white | 3.06:1 | Barely above 3:1 |
| Control border `#8A94A6` / page `#F7F8FA` | **2.88:1** | Insufficient where that border is the required boundary against this adjacent surface |
| Blue focus `#2563A6` / Ink `#172033` | **2.65:1** | Single-color blue outline is insufficient on Ink; define a valid inverse/two-layer treatment |

The documents already specify a white focus-offset token, which can contribute to an accessible multi-color indicator. Therefore the blue/Ink ratio is a **missing implementation prescription**, not proof that every possible focus design fails. Similarly, not every decorative border needs 3:1. Judge the cue required to identify the control or state against its actual adjacent colors.

**Correction:** list supported surface/foreground/control/focus combinations; give concrete default, hover, pressed, disabled, invalid, read-only, selected and inverse recipes for the initial components. Add an explicit inverse link/focus treatment and necessary secondary/danger states. Keep decorative borders distinct. Prefer a modest safety margin above contrast thresholds.

**Acceptance:** tested examples on white, page, subtle, selected and inverse surfaces, with full focus geometry visible. Do not round a failing ratio up to a pass.

### D-03 — Accessibility promises need executable acceptance criteria

**Priority:** required before accepting the foundation; apply feature-specific criteria when the feature arrives.

The new design baseline targets WCAG 2.2 AA, while `surfaces/ops-portal.md` §11 retains a WCAG 2.1 AA working target. A stronger target is sensible, but reconcile the owning documents deliberately so agents do not choose different baselines.

Add a short measurable checklist, referencing the standard rather than copying it:

- Normal text at least 4.5:1; large text 3:1; relevant control/state cues 3:1.
- WCAG 2.2 minimum pointer target rule of 24×24 CSS pixels or its valid spacing/other exceptions. Keep approximately 44px+ as the project's preferred touch target, not a vague substitute for the actual minimum rule.
- Keyboard operation, visible focus and focused controls not entirely obscured by sticky areas/overlays.
- Text resizing and reflow checks, including narrow layout/zoom; essential data tables may need a deliberate two-dimensional presentation.
- Forced-colors/high-contrast and reduced-motion behavior; no removal of native focus without a tested replacement.
- Field labels, stable IDs, help/error relationships, `aria-invalid`, form-error focus and non-duplicated live announcements.
- Accessible authentication: permit password managers and paste; choose appropriate autocomplete; do not turn OTP entry into an unnecessary memory/transcription barrier.

Automated axe scans are useful but do not prove all these behaviors. Include manual keyboard and a screen-reader smoke pass for the first identity flow. Keep the existing supported-browser promise (current/previous Chrome, Edge, Firefox and Safari) visible; Chromium-only Playwright does not fulfill it.

### D-04 — Connect the nine interface states to safe product copy

**Priority:** required before feature UI; document the policy during foundation reconciliation.

The new documents discuss loading, errors and empty states but do not provide the concise authoritative mapping back to `surfaces/ops-portal.md` §8: loading, empty, validation error, error, retry, offline, stale/conflict, success and permission-restricted. The Ops offline state is explicitly N/A; lost connectivity must not invent an offline write queue.

`COMPONENT_PATTERNS.md` §33 demonstrates `<Alert>{message}</Alert>`. It should specify that this means approved presentation copy, never direct rendering of the API's diagnostic `message`. The Ops contract explicitly requires machine-code-to-copy mapping.

`BRAND_FOUNDATION.md` §11's example “This action requires supervisor approval” is unsuitable as a reusable Melarc permission message: the retained Ops rules require permission-aware copy and explicitly reject role-name authority in applicable workflows. Use the owning feature's permission/approval wording.

**Correction:** one concise mapping/reference table, including “not applicable” where appropriate, and a clear error-copy boundary. Distinguish a rejected mutation from an unknown outcome before offering retry. Do not auto-replay mutations or invent success. Keep idempotency and version-conflict behavior in the feature adapter, not generic Button/Alert.

### D-05 — Map proposals to existing code before creating replacements

**Priority:** required before implementation instructions.

Every initial pattern is labelled PROPOSED, although `AppFrame`, `PageHeading`, `SkipLink`, `PrimaryNavigation`, `ErrorFallback`, route error handling and NotFound already exist. They are not yet the branded design system, but they should not be replaced with duplicate similarly named components just because the pattern document uses different names.

Add a small inventory with: proposed pattern, current component/path, retain/adapt/new, and acceptance tests. Preserve structural/focus behavior while moving styling onto tokens. Distinguish PageHeading (semantic heading/focus) from any composed PageHeader (title, supporting text, actions).

Remove conflicting scope wording: one section calls for all button variants/sizes initially, while later rules say only currently needed variants should exist. State the bounded first implementation precisely. Keep deferred patterns as short references rather than an expanding speculative catalogue.

### D-06 — Resolve asset, token and font ownership

**Priority:** required for consistent implementation; complete production variants before release, not all before the first token task.

The Brand Foundation §19 proposes a flat `design/assets/brand/` layout; the Design System §26 proposes `master/` and `exports/`. Choose one owner and make other documents link to it. The archive contains no production logo/font assets, so claims about PNG dimensions/sample colors were not reverified against artwork in this audit.

Define:

- Canonical logo source versus approved runtime export location, provenance and permission to use; no invented symbol-only or dark variant.
- Alternative text for linked logos and when a duplicate wordmark is decorative.
- Typeface decision, font license, self-hosted file/weights, fallback and loading strategy; ensure CSP and offline test isolation permit it.
- One executable token source and alias conventions, including units and CSS naming. Do not manually maintain competing CSS/JSON/Android copies.
- App-local tokens/components initially; create a shared package when another real consumer justifies it.
- Density/control sizes that remain usable with text enlargement; fixed visual sizes must not clip labels.
- One icon family when actually needed; accessible names for icon-only actions.

Do not make collection of every future brand variant block a neutral token/component demonstration. Do not call temporary artwork official.

### D-07 — Add Melarc formatting and identity integration boundaries

**Priority:** before the first affected feature, not a demand to implement all domain utilities now.

The design documents should reference the existing domain rules rather than redefine them: GHS and contract monetary representation; UTC persistence/Africa/Accra business time; the retained 24-hour display convention; null versus zero; safe truncation and copy behavior for identifiers. Format display separately from submitted values.

The first identity UI also needs a real decision for caller-capability discovery: the current Session schema does not supply a ready-made permission menu. Do not infer permissions from role names or populate a fake menu. Resolve it against the contract before implementing authenticated navigation.

## 8. Recommended UI implementation architecture

These are recommendations for the upcoming bounded task, not edits made by this audit.

1. **Keep React/Vite and the current ordinary-CSS foundation.** Encode semantic CSS custom properties and a small app-owned primitive layer. Tailwind is not required to obtain consistency; avoid adding it solely because an earlier discussion mentioned it.
2. **Use native elements for initial primitives.** Button, anchor/Router link, labelled input, status text and structural layouts do not require a headless component dependency. Evaluate a maintained accessible primitive library when a real dialog/menu/select requires complex behavior; verify compatibility then.
3. **Start in the existing Ops app.** A shared tokens/UI package is an extraction decision when Vendor becomes a real consumer, not a prerequisite for one application. Preserve a platform-neutral semantic model for Android.
4. **Use a development-only showcase.** Clearly labelled synthetic component examples, no session simulation or plausible customer records. Ensure its code/route/data are absent from production output; hiding a navigation link is insufficient.
5. **Keep one style authority.** Components consume tokens; feature code does not scatter brand values. Avoid heavyweight static rule engines. Review plus small behavior/contrast tests are sufficient initially.
6. **Keep product logic outside primitives.** Permission decisions, error-code mapping, request idempotency, query invalidation and session lifecycle belong in feature/platform adapters. UI variants receive presentation state.
7. **Do not introduce a full form framework, data grid, icon catalogue or Storybook installation without a current need.** A small showcase can demonstrate the first components. Broader tooling can be added when its maintenance cost is justified.

## 9. What a senior engineer should settle before actual features

| Timing | Required decision/evidence |
|---|---|
| Before calling bootstrap accepted | B-01/B-02 repaired; live DB/browser/integrated evidence; real CI and aggregate failure proof; branch rule; clean supported setup; truthful final source revision |
| Before design implementation | D-01–D-06 reconciled; explicit token pairings and focus recipes; typeface choice or agreed temporary fallback; existing-component map; narrow task scope |
| Before first identity endpoint | DTO/validation strategy, real security-scheme metadata, body limit, auth/CSRF/session behavior, error responses, declared cookie attributes/expiry, integration tests |
| Before authenticated navigation | Caller capability source and backend permission mapping; public/authenticated layout boundary; no role-name authority |
| Before first API-connected screen | Generated-client result-to-error adapter for TanStack Query; safe code-to-copy mapping; 401/403/409/422/429 handling as appropriate; mutation retry/idempotency policy; session/query-cache clearing |
| Before a feature uses external services | Local/test capture adapter and outbound boundary for that provider; no accidental production SMS/email/payment calls |
| Before deployment | TLS/database connection policy, reverse proxy/trust settings, static history fallback, security headers/CSP, environment/secrets, deployable packaging, migration orchestration, backup/restore and observability appropriate to release |
| Before supported-browser/feature acceptance | Required browsers and responsive widths, keyboard/screen-reader checks, accessibility evidence and real user journey |

The existing foundations should grow through actual slices. Rate limiting, real opaque sessions, permissions, audit writes, feature RLS policies and provider effects are not magically implemented by generic bootstrap tests. Equally, deferred production infrastructure should not be misclassified as a reason to rebuild B0.1–B0.9.

## 10. Bounded next tasks

### Task A — Repair process termination evidence

Send Claude this first; do not combine it with design work:

```text
Repair only the ManagedProcess lifecycle finding B-01 in the 5 October bootstrap/design audit.

Read e2e/CLAUDE.md, e2e/harness/managed-process.ts, its tests and cleanup callers.
The current child 'error' listener marks the process ended for every error. Node also emits 'error'
when signalling an already-running child fails; that is not proof of exit.

Distinguish a confirmed spawn failure from a post-spawn error. Do not set exited=true, remove the
child from tracking or resolve its termination promise merely because a running child emitted error.
Keep bounded graceful/forced shutdown, truthful failure and later cleanup possible.

Add meaningful regressions for a post-spawn signal error without exit, later actual exit,
stopAll retaining/reporting failure, and existing spawn-failure behavior. The no-exit case must
fail before the fix. Keep tests isolated; do not signal unrelated processes.

Run harness tests and relevant type/lint checks. Report exact changed files, commands/results and
any unexecuted integration checks. No contract edits, dependency upgrades, UI changes, staging,
commit, push, local-service startup or next task. Stop and report.
```

### Task B — Repair manifest validation

After Task A review, fix B-02 in `scripts/ci-revision.ts` and its tests. Start with the reproduced empty/missing-root counterexample. Reject malformed/inconsistent manifests and clarify source verification versus checksum matching. Keep CI topology unchanged unless the repair requires a documented narrow adjustment. Run root tests/types/lint and one valid plus invalid manifest verification. No deployment feature or signing framework is needed.

### Task C — Correct setup and packaging guidance

Correct B-03 and supply a source-review packaging procedure addressing B-04. Preserve local `.env` and user data. Define supported topology and exact non-destructive proof commands. Do not assume a public database bind is an acceptable workaround. Then gather B-05 evidence in the owner's actual development/CI environment.

### Task D — Reconcile design documents, documentation only

Address D-01–D-07 where relevant to the foundation. Preserve the approved brand/density. Add the existing-code mapping, layout boundaries, permitted contrast pairs, concrete focus/interaction recipes, accessibility test matrix, state/error-copy references and asset/token ownership. Keep genuinely provisional decisions visible without duplicating approval machinery. Do not install a library, change the API, or implement UI in this task.

### Task E — UI foundation implementation, after review

First encode approved tokens and adapt the existing frame/heading/error/not-found components. Prove keyboard behavior, focus contrast, responsive/zoom behavior, CSP-compatible fonts/assets and no production showcase. Then add the smallest labelled field/button/alert/loading primitives needed by SLICE-000 in the next bounded task. Do not build authenticated navigation until its capability source and route boundaries are decided.

## 11. Evidence and limits

The audit combined source review, archive delta comparison, command execution, negative probes, contract compilation, contrast calculation and retained-specification checks. It did not run production infrastructure, a real GitHub pipeline, PostgreSQL integration or browser acceptance. No claim of complete vulnerability absence, WCAG certification or production readiness is made.

Local evidence includes:

- `checks.json` and individual format/lint/types/build/client/contract/migration/test/audit logs;
- archive 8 install, root-test and formatting logs;
- per-workspace Turbo test summaries;
- `archive8-delta.json`, `archive8-preservation.json`, `archive8-links.json`;
- `process-error-probe.json` and `manifest-probe.json`;
- `contract-prepare.json` and contract structural comparison;
- pinned-browser installation failure log.

These evidence names identify the audit workspace outputs, not new files to add to the development repository. Do not reintroduce historical audit registers or approval engines into the active project.

Primary reference material consulted:

- [Node.js ChildProcess events and signalling](https://nodejs.org/api/child_process.html): an error may mean failure to spawn or failure to kill; it is not equivalent to an exit.
- [Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking): NAT and mirrored host-access behavior differ.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): proposed common web accessibility baseline; a target is not proof of conformance.
- [W3C non-text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html): relevant identifying cues/focus must be assessed against adjacent colors; decorative borders are not automatically subject to the same requirement.
- [W3C minimum target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): 24 CSS-pixel sizing/spacing rule and exceptions.
- [W3C accessible authentication](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html): support mechanisms such as password managers and paste rather than unnecessary cognitive barriers.
- [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): future dialog keyboard/focus behavior; no requirement to implement dialogs now.

**Final decision:** accept the existing technical and visual direction as worth continuing. Keep overall acceptance at **FIX REQUIRED / EVIDENCE OUTSTANDING** until the bounded fixes and missing checks above are closed. Then integrate the design system before building substantial product UI.
