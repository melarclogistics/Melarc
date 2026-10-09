# Melarc — final bootstrap and Slice-000 readiness audit

Date: 8 October 2026  
Verdict: **retain the bootstrap; revise the Slice-000 plan before execution.**  
Scope: source review, decision review, plan sequencing and acceptance review, and independent checks. No source changes, commits, pushes, deployments or database-service changes were made.

*Historical numbering: every `S0.NN` in this audit is a task of the draft plan it reviewed, not of the plan that now governs. The current identifiers and an old-to-new map are in [SLICE-000-IMPLEMENTATION-PLAN.md](SLICE-000-IMPLEMENTATION-PLAN.md) §12. The body below is left as written.*

## 1. Executive judgment

Melarc has a credible engineering foundation. The modular API, generated client, contract comparison tools, transaction-local database context, deny-by-default route declarations, test harness and existing UI tokens/primitives are worth retaining. Rebuilding bootstrap would waste the progress already made.

The uploaded draft is substantially better than a generic implementation checklist. Its operations and acceptance-criterion inventories are complete. It distinguishes failure transactions that must commit security state from failed business transactions that must roll back, accounts for platform plumbing, and puts recovery screens after recovery operations.

Nevertheless, it is **not yet a safe execution contract**. Several recommendations amend security policy without appearing in the contract-correction list; some criteria close before the behavior required to prove them exists; and several production/security prerequisites are deferred without an adequate implementation boundary.

The highest-priority decisions to revisit are:

1. Defaulting to a custom Android attestation parser/verifier to avoid dependencies.
2. Keeping recovery transactions open after answering the caller while invoking an external provider.
3. Recoverably storing one-time secrets for idempotent replay while still claiming the hash-only rule.
4. Letting permission removals leave existing sessions authorized until they expire or someone revokes them manually.
5. Leaving ordinary privileged users stranded when initial MFA enrolment expires.
6. Treating favorable localhost cookie behavior as sufficient browser acceptance.

These findings do not imply a current exploitable identity implementation: **there are no implemented product operations yet**. They identify what would be built incorrectly or left unproven if the draft were followed as written.

## 2. Baseline and independent verification

### Inputs

- Repository: `Melarc(20261008-062730).zip`.
- Draft: `Pasted markdown(20261008-064901).md`, titled “Plan: write the SLICE-000 implementation plan (revision 2, after independent review)”. This is a **plan for writing the implementation plan**, not the final task-by-task implementation document.
- Git HEAD: `9c34b69a75c58be4dc4131a0be0b78967a69594e`.
- Working tree: clean before review and after checks.
- Archive SHA-256: `b6c21054b6982e6014f47c758445a4113be78f1509500352f1882b631db07b6b`.
- OpenAPI SHA-256: `ca476f42a7677008597d5e16a6d4d75338f16b7f2de30d4310aaeeab3d5cb1a1`.
- OpenAPI: **172 operations and 171 schemas**; the Slice-000 catalogue contains **37 distinct operations**.
- The five identity feature files contain **125 acceptance-criterion headings**. The draft's closing columns cover exactly those 125 identifiers, without duplicates or omissions.
- The uploaded archive has **no `.env` files and no `node_modules` entries**. Omitting dependencies is correct; frozen-lockfile installation is the reproducibility mechanism. This inspection is not a comprehensive secret scan of Git history.

### Commands and outcomes

Checks used the pinned Node **24.21.0** and pnpm **11.1.3** in Linux. The root test run bypassed Turbo's cache.

| Check | Independent result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm run format:check` | Passed |
| `pnpm run lint` | Passed |
| `pnpm run typecheck` | Passed: four workspaces |
| `pnpm run build` | Passed: API and Ops |
| Root tests, through `pnpm test` | 1,181 passed, no skips |
| Ops component/config tests, through `pnpm test` | 220 passed |
| API unit/process tests, rerun separately after aggregate interruption | 1,568 passed, no skips |
| API-client tests, rerun separately | 250 passed |
| Harness unit tests | 191 passed; one environment-blocked failure |
| `pnpm run contract:check` | Passed, **zero implemented product operations compared** |
| `pnpm run api-client:check` | Passed: generated client current |
| `pnpm --filter @melarc/api db:check` | Passed: migration history check (not a live database test) |

The aggregate `pnpm test` exited nonzero. `e2e/harness/outbound-guard.test.ts:134` expected a Unix socket connection to succeed. A standalone Node probe, without the guard, also failed to listen on `/tmp/...sock` with `EPERM`. This establishes an execution-environment restriction, not a demonstrated outbound-guard bug. It still prevents calling the aggregate run green. Turbo interrupted other workspaces after that failure; the API and client results above come from completed separate runs.

Total completed passing assertions across those suites: **3,410**, with the one harness failure reported separately. No tests were changed or skipped to improve the result.

Not independently executed here: real PostgreSQL integration tests, Playwright browser suites, full integrated journeys, a new dependency-advisory scan, clean Windows/WSL setup, hosted workflow rehearsals, or manual assistive-technology passes. Repository statements about hosted runs and branch rules are recorded evidence, not a fresh inspection of GitHub settings in this audit.

### Bootstrap acceptance

The runbook records owner acceptance on 7 October at `25c1e05`, hosted successful runs, branch protection, and named waivers. That supersedes the earlier blanket B0.10-blocked assessment. Preserve that acceptance, while keeping waivers visible.

Acceptance is permission to proceed with development; it is not proof of release readiness. In particular, artifact verification belongs before deploying an artifact, platform/setup evidence before relying on that environment, and human accessibility evidence before accepting the first identity flow.

## 3. Findings requiring changes before the affected implementation

### F01 — Reopen the custom attestation-verifier decision

**Priority: high; blocks S0.42–S0.46 production-verifier acceptance.**

Evidence: draft D-04/D-06, S0.42–S0.44; `architecture/SECURITY_DESIGN.md` §15.2.1; `pnpm-workspace.yaml`.

Node crypto is a reasonable provider of cryptographic primitives. That does not make handwritten ASN.1/DER decoding and certificate-path validation the safest application choice. Node's `X509Certificate.verify()` verifies a signature; it does not perform all certificate validation. The package policy permits deliberate per-package build-script approval, so “pnpm blocks scripts, therefore dependencies are ruled out” is not an architectural constraint.

Google's current guidance recommends its attestation-verification Kotlin library and warns that custom verifiers miss edge cases. It also specifies the attestation extension nearest the trusted root, not an arbitrary “first” certificate in a client-supplied array. The retained specification says “first occurrence” without defining traversal direction. A leaf-first scan can select an attacker-appended extension.

**Recommendation:** retain the verifier port, but reopen implementation selection. Compare a maintained verifier/ASN.1 solution and the operational cost of Google's verifier before choosing. Do not automatically introduce a new service; document the bounded choice. If a custom implementation remains necessary, require specialist review and independently generated adversarial fixtures, not merely a custom decoder tested against one synthetic encoder.

Acceptance must include chain orientation and trust-anchor handling, constraints and critical extensions, bounded chain/extension sizes and nesting, malformed and duplicate fields, root rotation, revocation serial normalization, hardware-enforced fields, binding to the attested key, and the correct factory-certificate versus RKP expiry rules. Synthetic chains establish selected cases, not compatibility with real handsets. Require a real hardware-backed device before production use.

Keep P-256/SHA-256 as a reasonable protocol proposal, but define exact byte encodings, challenge decoding, signature format, replay binding and limits, and obtain Android interoperability vectors before implementing the protocol as settled.

### F02 — Recovery delivery needs an architectural decision, not just a detached-promise helper

**Priority: high; blocks approval of D-19 and S0.13/S0.38 as designed.**

Evidence: `SECURITY_DESIGN.md` §13.9a, especially the paragraph beginning “requestCredentialRecovery is the exception”; draft F-05/N-23; `DatabaseService.runInTransaction`; `ShutdownRegistry`.

The draft accurately follows the existing specification: respond uniformly, then call the delivery provider while the database transaction remains open. The problem originates in that specification, not simply Claude's interpretation.

A slow provider occupies pooled connections and may hold locks after the HTTP request has ended. Enough requests can exhaust the pool. A process crash after the 202 loses uncommitted work. A provider may accept a message whose database commit later fails; the specification already acknowledges the dead link. SIGTERM draining cannot repair SIGKILL, host failure or ambiguous provider acceptance. A “ready signal” also does not itself prove the HTTP response finished before the provider was called.

**Preferred direction for discussion:** a small durable PostgreSQL-backed delivery workflow, with explicit pending/accepted/failed states, retry and deduplication rules, bounded workers, and a narrowly encrypted delivery payload or another carefully reviewed token-reconstruction design. A broker or Redis is not inherently required. This changes the hash-only/outbox prohibition and belongs in an approved specification change.

If retaining in-process best-effort delivery temporarily, state the loss semantics explicitly. Require total concurrency/queue limits, provider cancellation and timeout, database lock/statement/transaction deadlines, shutdown dependency ordering, response-finish/error handling, and crash-after-202 / send-before-commit / ambiguous-timeout tests. Apply the analysis to all credential-message operations, not only self-service recovery.

Uniform recovery responses are worth keeping. Exact equality of SQL statement counts and dummy writes is not itself an anti-enumeration proof and must not become an unbounded resource cost.

### F03 — Encrypted replay is a contract exception, and its lifetime conflicts with ordinary idempotency

**Priority: high; blocks D-20/S0.41.**

Evidence: draft N-24; `domain-model.md` §6.9 SetupGrant; `SECURITY_DESIGN.md` §13.9a and §14.16; `settings.md` `idempotency_record_ttl_hours`; `permission-enforcement.md` §5.1.

The retained rule is hash-only token/challenge storage and original-result replay. N-24 instead stores recoverable encrypted token material, removes it on consumption/supersession, and answers `STATE_CONFLICT` after the grant expires. The general idempotency record lasts 24 hours; the ordinary grant lasts 30 minutes. These can be deliberately reconciled, but are not the same behavior.

**Recommendation:** resolve one explicit operation-specific replay contract before S0.9. A practical choice is a narrow encrypted-secret exception with a documented short disclosure window and a durable 24-hour tombstone that prevents re-execution after disclosure ends. The exact post-window result must be declared in OpenAPI and the owning rules. Alternatively redesign the response/issuance protocol to preserve hash-only storage. Do not silently mint a new grant on replay.

Reuse a reviewed encryption abstraction if appropriate, but use purpose-separated keys or derivation contexts and authenticated metadata binding principal, operation, record and version. “Use the TOTP cipher” must not mean an unexamined shared key, nonce policy and retention policy. Wiping a live row does not erase backups or WAL; the security claim must reflect that.

Concurrent retries, consumed grants, supersession, permission withdrawal, failed commits, encryption-key rotation and retries after the window all need defined outcomes.

### F04 — Reconsider delayed permission withdrawal

**Priority: high policy recommendation; resolve before session/authorization design.**

Evidence: accepted decision in `permission-enforcement.md` §5.5; draft S0.18; `settings.md` session lifetimes.

Keeping a session's authorization snapshot is useful for auditability. Keeping removed permissions usable until the next sign-in is a separate choice. With the current policy, an operator can remove a sensitive grant and still leave active users able to exercise it for the remaining session lifetime unless someone independently finds and revokes every session.

**Recommendation:** retain snapshots, but make a security-reducing bundle edit atomically invalidate affected sessions or an authorization version checked on every request. Additions may wait until the next sign-in. Assignment changes and removal/expiry of hub authority should likewise retain their immediate invalidation rules.

This does not require resolving the whole mutable bundle on every request. The architecture already performs a server-side session lookup. If you intentionally keep manual revocation, the future bundle-edit operation must expose and enforce the operational consequence clearly; it must not look like permissions were removed immediately when they were not.

### F05 — Close the ordinary privileged MFA dead end

**Priority: high; blocks S0.27 acceptance.**

Evidence: `SLICE-000.md` §6; `credential-recovery.md` AC-119; draft D-13 versus S0.27.

D-13 recommends allowing recovery of a non-bootstrap privileged identity with only a PENDING factor. S0.27 still says the operation refuses that target. Both instructions cannot govern the same implementation.

**Recommendation:** approve a narrowly defined recovery/re-enrolment path for that ordinary privileged identity, performed by another authorized administrator, reasoned and audited. It must supersede old pending material, deliver through the approved channel, and create neither an active factor nor a session until the user proves the new factor. Preserve no self-reset and no MFA bypass. Amend AC-119 and the state machine together.

The provisioning-only bootstrap resume command remains distinct and must not become a generic MFA-reset backdoor.

### F06 — Add database privilege and resource boundaries to the platform tasks

**Priority: high; before the first identity tables and anonymous authentication workload.**

Evidence: `database.service.ts` ROLE_POSTURE_SQL comment explicitly excludes schema/function ownership and CREATE privileges; `database.module.ts` has connection and idle-pool timeouts, but no SQL/transaction deadlines; draft S0.4.

Closing the public `db` handle is correct. It is not a complete pre-authentication privilege design. A closed string capability is not independently unforgeable when the runtime can set its own context; the repository already honestly accepts that residual risk.

Specify an access matrix for authentication, seed and provisioning capabilities: allowed tables, operations, lookup predicates, technical identity, and composition roots. Keep provisioning credentials/tools outside the API's usable runtime configuration. Do not add `SYSTEM OR ...` policies that confer unrestricted table access. Separate database-role privileges where stronger separation is needed.

Extend posture checks for the DDL privileges already prohibited by §14.6, including applicable schema ownership/CREATE and privileged function ownership or execution paths. Add tests using the actual runtime role. Name statement, lock and transaction timeout ownership before introducing provider waits or adversarial anonymous load.

For D-22, distinguish an identity's hub membership/reach from the scope of the grant authorizing the operation. `hub_reach=ALL_HUBS` must never override a hub-limited permission grant. Seed explicit per-grant all-hub authority where intended and test mixed-scope grants.

### F07 — Separate transport safety from business refusal precedence

**Priority: high; revise S0.15 and C-10 before implementation.**

Evidence: draft F-02 and S0.15; `create-app.ts`; `json-body.ts`; permission-enforcement §5.1.

Deferring a safe, bounded JSON syntax error until after authentication can be feasible. Requiring authentication to take precedence over every oversized/malformed transport request is not a sound universal rule. Some requests cannot be safely framed or parsed at all; Node and the edge can reject them before Nest sees them. A credential limiter that extracts an email or token also needs a bounded extraction step before full business validation.

Define two boundaries: transport/resource admission (headers, body bytes, encoding, decompression, deadlines and framing), then authenticated business refusal order for admissible requests. Preserve early resource rejection and never buffer unbounded data merely to return a preferred code. Do not claim 401/429 for every malformed request at every layer.

C-10 also needs an operation-by-operation browser/native distinction. Requiring an allowlisted Origin on browser credential flows is defensible; a blanket “missing Origin allowed before session” is not a complete browser CSRF policy. Define missing/null Origin, Fetch Metadata or other admitted-client rules, JSON-only content, CORS behavior, and native Rider exceptions. Do not add browser-specific 403 behavior mechanically to every pre-auth operation without checking its client.

### F08 — Rate limits must survive topology and avoid identity-dependent overload behavior

**Priority: high before exposed authentication; bounded local implementation may proceed once constraints are explicit.**

Evidence: D-07/D-14/D-26, S0.11; settings §7.7/§9; deployment §12.2.

An in-process limiter is reasonable for a documented single-instance development topology. It resets on restart and multiplies allowance across instances. A port alone does not preserve a security guarantee across a deployment change. Bound key length, total buckets, expiry and eviction behavior, concurrency and queued hashing; otherwise “bounded memory” can mean an attacker evicts another user's bucket repeatedly.

Keep the hash-work ceiling, but apply it uniformly before identity-dependent expensive work. Rate-limited requests must not perform the dummy hash just to match other branches: the retained policy explicitly says they are not verified or counted. Compare equivalent outward-response branches, not success, lockout, invalid-input and throttled paths indiscriminately.

Resolve `requestAdditionalDeviceGrant` keying before that operation. Edge limits and trusted-proxy/client-address derivation are deployment prerequisites, not a Product Owner's arbitrary number. An engineer should propose measured values and NAT/shared-network implications for approval.

### F09 — Real-browser authentication needs a secure test origin

**Priority: high for accepting browser identity flows; affects D-17/S0.34.**

Keep Secure cookies. Record localhost behavior as diagnostic evidence, but do not accept “journeys run only where the cookie is stored” as coverage of the supported browsers. Provide an HTTPS test/development path with a trusted test certificate or equivalent deployment-like secure origin, then run the actual sign-in/CSRF/sign-out journeys in all supported engines.

Cookie presence is not sufficient. Prove host/path/SameSite behavior, expiry attributes, deletion using matching scope, session rotation, rejection of ambiguous credentials and session invalidation. Session cookies do not guarantee logout when a browser closes; browser session restoration and server expiry are separate mechanisms. Avoid promising otherwise in user-facing copy.

### F10 — Fix task dependencies and acceptance closure semantics

**Priority: high for approving the final plan.**

Inventory completeness is confirmed, but these examples contradict the draft's own “all clauses, real operations” closure convention:

- S0.15 closes AC-25 before S0.16 supplies authenticated sessions; if it is a fixture proof, label it as such and close the operation-level obligation later.
- S0.18 closes AC-26/29/44 using a test-only operation, while the draft explicitly says no product route exists until S0.21. Keep the platform proof, but distinguish it from final real-operation closure.
- S0.41 closes AC-40, which describes a rider establishing a PIN on the handset and the officer's QR screen. Device completion arrives in S0.44 and the Ops screen in S0.47; the Rider client is deferred. Record API/contract proof separately from client evidence.
- S0.46 calls AC-54 closed while carrying clauses into future slices. “Verified for implemented operations; residual owned by later slices” is accurate. “Every clause closed” is not.
- S0.11 promises concurrent sign-in HTTP tests before sign-in exists. Name a test-only workload fixture there and re-run against real endpoints in S0.22/S0.36/S0.46.
- D-20 governs the generic store design at S0.9 as well as its use at S0.41. The dependency currently comes too late.
- D-24 placement must precede interfaces and persistence ownership, not only document linking.

Use a small clause-level evidence mapping where a criterion spans API, browser and future client behavior. Do not manufacture new governance. Citation/no-skip tests catch omissions; they cannot establish assertion quality or that the test exercises the intended behavior. S0.50 must not be described as proving semantic coverage by reading test titles.

S0.30 is still too large for one bounded task: table, states, shell, dialog, reason selection, forms, retry identity and three-engine tests. Split by usable dependency: form/accessibility helpers; table/read states; confirmation/reason workflow; authenticated shell/navigation. D-02's exact number of tasks is an engineering organizational choice, not a product decision.

### F11 — Defer audit checkpoints only with an explicit production boundary

**Priority: high release condition; development deferral is reasonable.**

Evidence: settled D-09; `contracts/audit.md` §2.1; security design §14.11.

Append-only audit is useful and must arrive with identity actions. It is not tamper-evident history against privileged database/infrastructure modification. The retained documents explicitly distinguish them.

Keep checkpoint infrastructure deferred during local feature development if desired, but require it before production relies on the claimed tamper-evidence control. Make the audit writer preserve stable event identifiers, canonical data and ordering needed later. Record that protection is not retroactive to events predating the first independently protected checkpoint. Do not mark checkpoint-specific security tests passed or simply irrelevant forever.

Request-time session expiry can remain the access-control mechanism; a cleanup job is a separate retention/operations concern. Deferring worker/scheduler/relay roles is reasonable only while no implemented workflow depends on them. F02's durable delivery choice may change that boundary.

### F12 — Prove the QR handoff, not just its source string

**Priority: medium; S0.29/S0.48.**

Reading the enrolment URI from an intercepted response proves the API emitted it. It does not prove that the rendered QR encodes it correctly or can be scanned. Use an independent decoder in a component/integration test to decode the actual generated output, and a handset smoke test for the operational handoff. This need not add a production decoder dependency.

Not rendering a token as text reduces accidental copying; it does not make a QR secret inaccessible to the officer or to screenshots. Describe the real guarantee accurately: the officer never learns the rider's PIN/private key; the short-lived enrolment bearer material is necessarily present in their browser to display the QR. Continue clearing it and excluding it from traces/screenshots/logs.

### F13 — Clarify normalization and time semantics before tests pin accidents

**Priority: medium; S0.3/S0.16.**

The contract explicitly applies raw-string 12–128 bounds as a prefilter and normalized bounds in the service. That is a dual acceptance rule, not purely “12–128 after NFKC”. For example, four U+FB03 ligatures have four raw code points and normalize to twelve (`ffiffiffiffi`); the wire prefilter rejects them. Decide whether this intentional restriction stays, and state it consistently in the UI/tests. Do not silently move normalization ahead of generic schema validation and alter the wire contract.

Keep password normalization separate from email normalization: passwords must not be trimmed or case-folded. For email, the approved whole-address lowercase policy is a product canonicalization choice; preserve original display form and verify collision behavior.

“Database clock” also needs a precise meaning. PostgreSQL transaction time is fixed at transaction start; wall-clock time advances. Define which instant governs expiry after lock waits and in long transactions. Test expiry at equality, waiting past expiry, concurrent consume and TOTP replay. Use monotonic time for process budgets; avoid banning `new Date(value)` used merely to parse a timestamp as if it were a clock read.

### F14 — Specify the platform/domain interfaces before identity persistence grows

**Priority: medium; D-24/S0.0–S0.5.**

`platform/` may not import domain modules, and the repository tests enforce that direction. Putting auth routes there is consistent with the architecture, but those routes need staff/vendor/rider data. The draft must name the repository ports, implementations, transaction ownership and composition-root wiring that permit this without circular imports or duplicated persistence.

Permission domains need not dictate every internal helper/module directory. Do not turn a folder decision into a new product permission domain. Preserve the existing dependency boundary; amend its prose narrowly if necessary.

The current UI uses React and CSS tokens; Tailwind and Radix are not installed. Do not retrofit the earlier conversational stack recommendation as an approved dependency change. Keep the existing primitives and choose an accessible interaction primitive deliberately when dialogs or other complex components require one.

## 4. Review of the contract-correction list

S0.1 is a good place for reviewed contract amendments. It is not enough to approve the sentence “all corrections” without seeing their meaning. Keep each decision distinguishable even if delivered in one pull request.

| Item | Recommendation |
|---|---|
| C-01: five missing 400 responses | Confirmed: the five named operations lack 400. Add the declared validation response and tests for their actual request fields. |
| C-02: stale setup MFA error | Align it with the revised two-step flow. Remove only the impossible outcome, not the no-session-before-MFA invariant. |
| C-03: secret response no-store | Keep. Platform already sends no-store on every response; contract declarations should agree. |
| C-04: additional-device text/settings | Reconcile with the final limiter/key decision, not a text-only edit that leaves the key unset. |
| C-05: staff.device.register holders | Resolve in the permission owner and reflect the same grant/tier rules in seeds and tests. |
| C-06: Session display data | Reasonable. Define a bounded display projection for all principal types, nullability, hub labels and snapshot/freshness semantics. Do not return bundle internals or credentials. Permission keys remain UI hints; server authorization is authoritative. |
| C-07: emailed-link fragments | Reasonable, but define setup, recovery and MFA re-enrolment routes separately, fixed configured origins, encoding and invalid-token handling. Clear fragments promptly; prevent analytics/error captures from retaining them. |
| C-08: rider enrolment URI | Define a versioned format, scheme/host, strict parser, token/challenge encoding and app handling. No arbitrary redirect/destination accepted from the URI. |
| C-09: rider signature protocol | Reasonable proposal; needs cross-platform byte-level test vectors and binding/expiry/replay semantics. |
| C-10: pre-session Origin | Revise per F07. Classify browser and native operations before adding responses. |

Additional intentional amendments may be required by F02, F03, F04 and F05. They must not be smuggled into S0.0 as “spec refinements, no behavior change”.

## 5. Owner decision review

The following are recommendations, not approvals recorded on your behalf.

| Decision | Disposition and reason |
|---|---|
| D-01 plan path | Keep the proposed path and concise links. |
| D-02 54 tasks | Keep bounded stages; let task size determine count. Split S0.30. |
| D-03 platform first | Keep essentials first, then the earliest complete staff vertical path. Avoid speculative machinery for later features. |
| D-04 built-in crypto | Keep as a preference for suitable primitives, not an absolute prohibition on reviewed security dependencies. Use async Argon2 in request paths. |
| D-05 QR encoder | Keep a small maintained, reviewed encoder; add independent decode proof. “Zero dependencies” alone is not a quality criterion. |
| D-06 custom DER | Reopen per F01. |
| D-07 in-process limiter | Accept for explicit topology only; document distributed/restart limitations and release requirements. |
| D-08 local keys | Local substitutes are appropriate. Production must fail closed; explain key versions, rotation, separation and recovery. |
| D-09 deferred jobs/checkpoints | Accept for development with F11's production gates. Revisit if durable credential delivery is chosen. |
| D-10 minimal tables | Keep, with forward-only schema changes, complete constraints for implemented behavior, and named dependencies. No fake HubAssignment or allowance behavior. |
| D-11 permission seeds | Seed the approved closed catalogue or explicitly define the active slice subset; unknown keys fail closed. Never infer permission from role names. |
| D-12 reasons | Test fixtures can unblock engineering. Approve legitimate reason names/codes before manual acceptance; fixtures cannot become accidental production seeds. |
| D-13 stranded MFA | Change the current refusal as described in F05. |
| D-14 limiter key/edge ceiling | Engineering proposes the key and measured ceiling; owner accepts operational impact. Do not defer beyond the affected operation/exposure. |
| D-15 MFA audit cause | Add a closed, non-secret cause with no lock counter increment. |
| D-16 grouped smaller questions | Split into concrete choices. Cross-hub audit, delivery-channel selection, recovery supersession and client ownership have different consequences. |
| D-17 cookie engines | Replace skip-by-cookie-support acceptance with a secure-origin journey path. |
| D-18 provisioning bundle | Restricted file is reasonable, but Windows ACLs need explicit handling; POSIX mode alone is not portable access control. Minimize lifetime and record custody. |
| D-19 detached completion | Reopen per F02. |
| D-20 encrypted replay | Approve only as an explicit exception with replay/tombstone/key semantics per F03. |
| D-21 metrics | Keep bounded, low-cardinality counters/gauges. No identifiers in labels. Technical endpoint exposure/authentication must be defined; no new public endpoint by convenience. |
| D-22 all-hub identity reach | Accept only with per-operation grant intersection; never a principal-wide bypass. |
| D-23 grant tier | Reasonable if target-sensitive tier and MFA classification derive from authoritative grant/bundle metadata and cannot be client-chosen. Test grant edits and privilege reduction. |
| D-24 module placement | Keep the dependency direction; specify ports/adapters before code. Folder names are not product domains. |
| D-25 local acceptance walk | Accept for local functional development evidence only. Do not quietly waive the existing Staging requirement; separate functional completion and deployment acceptance, with an explicit amendment if chosen. |
| D-26 hash ceiling | Keep, measured and uniformly applied, with queue/memory bounds and a declared overload result. |
| D-27 copy | Agents can propose copy. Centralize by operation/context and code, including field errors; one global message per code is often insufficient. Owner reviews visible screens, not low-level phrasing constants individually. |

Other approved directions should stand: Crimson + Ink, balanced density, self-hosted Inter, the existing CSS-token foundation, neutral pre-auth/setup frame, no fabricated operational data, backend permission enforcement, opaque sessions, MFA before privileged sessions, separate Rider bearer authentication, and two distinct human bootstrap custodians. The old neutral-frame decision is now recorded as approved; it is not still an open blocker.

The explicit staff cross-hub existence signal is a conscious operational tradeoff, not automatically a defect. Keep it staff-only, permission/tier gated, narrowly projected and audited; never extend it to vendors/riders.

## 6. UI readiness and stable implementation approach

The first UI foundation already exists. Do not start another design-system rewrite or introduce a broad component kit ahead of actual needs.

Before accepting the identity flow:

- Preserve the existing token authority, component accessibility behavior, generated API types and single browser-client boundary.
- Define form label/help/error relationships, focus-first-invalid, pending submission and duplicate-submit behavior.
- Treat a network-lost mutation as unknown outcome: do not automatically create a fresh idempotency key and potentially repeat the action.
- Preserve ETags/status/declared error details in a bounded client response abstraction; never expose server exception text as UI copy.
- Keep password/MFA/grant material out of persistent query caches, storage, analytics and failure artifacts; clear transient state on completion/navigation/expiry.
- Use permission-driven navigation only after the Session projection exists; hiding a link never authorizes or secures the endpoint.
- Verify dialogs, keyboard/focus return, zoom, responsive tables, forced colours and screen-reader flow on real composed screens.
- Keep manual screen-reader/Safari/Edge evidence distinct from automated Chromium/Firefox/WebKit assertions.
- Do not mark all nine interface states implemented merely because enum names or generic components exist; apply each state to the real screen or explicitly mark it inapplicable.

The existing UI tests are useful evidence. They are not evidence that sign-in, recovery, staff approvals or MFA are accessible yet, because those screens do not exist.

## 7. Revised execution direction

Do not approve the whole draft for implementation as it stands. The next bounded task should be **plan/spec amendment only**, after discussing the policy findings in this report.

Recommended order:

1. Settle F01–F09 decisions that affect architecture, contracts or authentication acceptance; retain explicit local-versus-production boundaries.
2. Produce concrete contract/spec deltas, including the changes beyond C-01–C-10. Review behavior, not just file lists.
3. Correct task dependencies, split oversized UI work, and replace premature “closed” labels with accurate evidence levels.
4. Write the final implementation document with each task's inputs, outputs, smallest meaningful tests, rollback/stop conditions and outstanding evidence.
5. Execute only the first approved task. Review its source and actual results before the next dependent task.

Do not add old-style approval/history machinery to the repository. The retained plan should be a practical execution guide. This audit is a review artifact, not another source of runtime policy.

## 8. External technical references

Consulted 8 October 2026; repository findings above are grounded in the uploaded files.

- Node v24.21.0 Crypto documentation: https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html — built-in APIs and the limited guarantee of `X509Certificate.verify`.
- Android Key Attestation verification: https://developer.android.com/privacy-and-security/security-key-attestation — rootward extension selection, verifier guidance, revocation and factory/RKP expiry distinctions.
- OWASP Forgot Password Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html — uniform responses/timing and recovery-token controls. The durable delivery recommendation is this audit's engineering judgment, not an OWASP requirement to use a particular queue.
- PostgreSQL date/time functions: https://www.postgresql.org/docs/current/functions-datetime.html — transaction, statement and wall-clock time semantics.

## 9. Limits of this conclusion

This is a deep source/plan/decision review plus independent bounded execution. It does not certify production security or promise zero remaining defects. No real identity implementation is being approved by these test counts. The appropriate result is a targeted plan revision, followed by small tested implementation gates—not restarting bootstrap and not declaring the whole project green.
