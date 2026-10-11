# Melarc — Slice-000 final architecture and implementation decisions

Version: 1.0  
Date: 8 October 2026  
Intended repository path: `delivery/planning/SLICE-000-FINAL-DECISIONS.md`  
Audience: Product Owner and Claude Code, executing one bounded task at a time.

## 1. Authority, scope and readiness

This document consolidates the resolution of audit findings **F01–F14**, contract clarifications **C-01–C-10**, and planning decisions **D-01–D-27**. It supplies the behavior, implementation boundaries and acceptance evidence that the revised Slice-000 plan must follow.

The owner explicitly approved F02, F03, F04 and F06, agreed to the F01 library direction, and proceeded through discussion of F05 and F07. On 8 October the owner authorized completion of the remaining recommendations in this final document. F05, F07 and the remaining resolutions below are therefore **final recommendations made under that delegation**, not falsely attributed earlier individual approvals. Engineering values that depend on actual deployment capacity remain measurement deliverables with explicit release gates; they are not silently chosen product policy.

**Decision complete does not mean implementation complete.** These decisions authorize specification and plan correction. They do not certify unbuilt identity operations, approve deployment, or replace evidence with confidence. Preserve the accepted bootstrap and develop incrementally.

This document changes behavior where it explicitly says so. Claude must amend the owning specification, OpenAPI, generated client, tests and plan together as applicable. Once reconciled, runtime facts continue to live in their owning documents; this file explains the decisions and their rationale. Do not recreate historical governance registers or copy every setting into multiple sources of truth.

### Reviewed baseline

- Repository archive: `Melarc(20261008-062730).zip`.
- HEAD: `9c34b69a75c58be4dc4131a0be0b78967a69594e`.
- Archive SHA-256: `b6c21054b6982e6014f47c758445a4113be78f1509500352f1882b631db07b6b`.
- Canonical OpenAPI SHA-256: `ca476f42a7677008597d5e16a6d4d75338f16b7f2de30d4310aaeeab3d5cb1a1`.
- Draft reviewed: `Pasted markdown(20261008-064901).md`, revision 2 of the plan for writing the implementation plan.
- Baseline inventory: 172 contract operations, 171 schemas; 37 Slice-000 operations; 125 acceptance headings across five identity feature files. These are inventory checks, not proof of implementation.
- Audit: `MELARC_SLICE_000_READINESS_AUDIT_2026-10-08.md`.

The prior audit completed 3,410 passing assertions across separate suites. The aggregate run was not green because a Unix-socket harness case encountered an independently reproduced environment restriction. Live PostgreSQL, complete browser journeys, real Android attestation and production deployment were not independently verified here. This decision review re-read relevant source, specifications and draft sections and consulted primary technical guidance; it did not rerun all suites or change the repository.

If Claude's current HEAD differs, inspect the relevant diff and preserve newer user work. Do not reset to this baseline.

**Task numbers.** The `S0.NN` identifiers in this file are those of the draft plan under review. The plan that now governs is [SLICE-000-IMPLEMENTATION-PLAN.md](SLICE-000-IMPLEMENTATION-PLAN.md); its identifiers are stable and splits use suffixes. Active references below carry the current identifier with the draft one in brackets; the old-to-new map is in plan §12. The table in section 12 below is kept as the history of the draft's claims.

## 2. Architecture retained

Keep NestJS/Express, PostgreSQL, opaque server-side sessions, generated API types, transaction-local security context, deny-by-default route declarations, existing contract tooling, and the React/CSS-token UI foundation.

Retain Crimson + Ink, balanced operational density, self-hosted Inter, the neutral pre-auth/setup frame, and existing accessible primitives. Do not add Tailwind, replace the design system, or build speculative components to satisfy an old conversational recommendation.

The intentional additions are a private Kotlin/JVM attestation verifier, a durable PostgreSQL credential-delivery workflow, strengthened database boundaries, authoritative rate-limit storage for deployed identity flows, and trusted HTTPS identity testing. No Redis or general-purpose message broker is required by this decision.

## 3. F01 — Android attestation verification

### Decision and rationale

Use the Android project's `android/keyattestation` Kotlin library in a **persistent private JVM verifier**. Do not write a Melarc DER parser or certificate-path validator. Keep the NestJS verifier port so transport and library details remain isolated.

The verifier is a small service with a versioned request/response interface, bounded input, bounded concurrency, a deadline and a restricted network boundary. It receives the chain and expected verification policy/context, returns a verified key and structured non-secret outcome, and has **no database credentials**. Do not spawn a JVM per request. Pin the library, JDK and build dependencies to reviewed versions; the previously discussed v0.2 is a candidate to qualify, not permission to follow an unpinned branch.

The verifier task must include reproducible Gradle/JDK builds, dependency verification, CI coverage and local Windows/Linux start/stop instructions. Keep its build independent of Node package discovery while including its tests in the required gate. Bind locally or to a dedicated private network; use authenticated transport if it crosses hosts, and reject access from the public edge.

NestJS owns authorization, grant lookup and the final atomic enrolment/replacement. PostgreSQL owns grant expiry, consumption and device/session state. The verifier owns certificate and attestation evaluation. Its in-memory replay cache must never replace database single-use enforcement.

Internal distribution of a signed Rider APK remains valid. The app does not need Play Store publication or Google hosting. Device eligibility and Google-rooted hardware attestation are separate requirements from distribution.

### Mandatory policy

Require the approved package name and release signing-certificate SHA-256 allowlist, acceptable hardware security level, verified boot/locked-device policy, challenge match, key purpose/origin/algorithm, chain and revocation validation, and binding to the key actually attested. Do not copy permissive unknown-package example settings. Reject debug signers in production.

Use the trusted attestation extension nearest the root. Apply the library's supported factory/RKP certificate handling and independently test Melarc's required cases. Bound certificates, chain bytes and parsing work. Load trust data only from fixed configured sources, with response-size, network and freshness limits; never follow certificate-supplied URLs arbitrarily.

Maintain a last-known-good trust snapshot within the existing permitted age. Beyond that age, enrolment/replacement fails closed with the specified technical outcome. Ordinary sign-in and existing sessions do not acquire a new dependency on verifier availability. Deployment health must distinguish enrolment degradation from total API unavailability.

Perform external verification outside the mutation transaction. On returning, lock/re-read the grant, expiry, actor authority and relevant device state before applying one atomic change; another request may have consumed or revoked them while verification ran.

### Closure evidence

Library/package and signer policy tests; wrong/unknown roots; revoked certificates; duplicate/malformed extensions; rootward selection; wrong challenge/package/key; input limits; stale trust data; verifier timeout; concurrent consume/replacement; no production substitute; real internally signed APK on eligible hardware. Synthetic fixtures alone do not close hardware acceptance.

Owners: security design §15.2, Rider feature, C-08/C-09, S0.1, S0.2 and the replacement tasks S0.54 to S0.59 (draft S0.2 and S0.42–S0.46).

## 4. F02 — Durable credential-message delivery

### Decision and transaction model

Replace the detached open transaction and provider-before-commit model with **a durable encrypted delivery job committed in PostgreSQL**, processed by a separate Node worker. Apply it consistently to setup, recovery, MFA re-enrolment and additional-device messages that use a provider.

1. Validate the operation and choose the registered destination; never accept a replacement destination from an anonymous request.
2. In a short transaction, create the hashed redemption record, minimal encrypted delivery payload and required audit event.
3. Commit before acknowledging durable acceptance.
4. A worker claims a job with a lease in a short transaction, releases the connection, calls the provider, then records its outcome in another transaction.
5. Retry only the same job/token with bounded backoff and a stable provider deduplication identifier where supported.

For anonymous recovery, eligible and unknown identities receive the same 202 and body. No provider call belongs on that response path. Failure to persist a required job is an operational failure, not a successful acceptance. All equivalent outward branches need bounded work and anti-enumeration testing; do not manufacture unlimited dummy database writes to force identical statement counts.

### State, secrecy and delivery uncertainty

Separate credential validity from delivery bookkeeping. Define queued, leased, accepted, retryable failure, terminal failure, expired and cancelled outcomes; distinguish provider acceptance from delivery to the recipient. Lease ownership/version must fence stale workers from overwriting a later outcome. A timeout may mean the provider accepted the message. Reconcile where supported or safely retry the same link. Do not promise exactly-once delivery.

The redemption record stays hash-only. Recoverable delivery material is a narrow encrypted exception: authenticated encryption, purpose-separated keys, versioned envelopes, minimal destination/template/token fields, no credentials in logs or audit. Remove ciphertext after confirmed provider acceptance when no reconciliation/retry requires it, or at terminal expiry/cancellation. Metadata can remain under its own retention policy. Live-row deletion does not erase WAL, replicas or backups.

A worker checks cancellation/expiry before sending. A send already in flight can still arrive after cancellation; redemption must reject it. Shutdown stops new claims and finishes or relinquishes leases within a bounded budget. A crash must leave recoverable committed work.

### Recovery supersession resolved

Preserve the existing 60-second self-service coalescing interval. A queued successor must **not invalidate a usable recovery link**. For a bounded implementation, allow at most **two unexpired, unconsumed self-service/admin recovery links combined per credential**; at the cap, coalesce rather than invalidate one to make space. Count requests in the limiter even when coalesced. This cap is a new delegated product recommendation and must be reflected in the owning rule and concurrency tests.

An authenticated administration request inside the coalescing interval or at the cap returns the existing eligible recovery request's non-secret metadata and records the administrative request outcome; it does not claim a new message was delivered. Where no reusable live request exists, it creates a new one. Repeated requests must not grow an unbounded queue.

Successful recovery atomically changes the credential, clears the applicable lock, terminates sessions, invalidates all outstanding recovery links and cancels pending jobs. MFA, authority and suspension remain governed by their existing separate rules. A new setup grant or explicit MFA reset may intentionally revoke a previous setup/factor; do not incorrectly apply recovery-link coexistence to every grant purpose.

### Contract and evidence

Change synchronous delivery-failure/rollback prose in all affected operations. Retain their resource response shape where possible, but describe **queued acceptance**, with 202 where delivery is pending, and add bounded delivery status only where required by the caller. Provider rejection after commit is a job outcome, not retroactive HTTP failure. Preserve resource identifiers, ETags and client handling for changed statuses.

Prove crash-after-commit recovery, lease expiry, duplicate claims, provider timeout/late acceptance, failure before commit, no connection held during send, coalescing races, bounded live links, worker restart, secret erasure and recovery invalidation. Inspect committed state from a second connection.

Owners: credential-recovery feature; SetupGrant/RecoveryRequest and new delivery-job definitions; state machines; audit; security §13.9a; background jobs; database grants; S0.17 to S0.19, S0.36, S0.37 and S0.49 to S0.51 (draft S0.13, S0.26, S0.27 and S0.37–S0.39).

## 5. F03 — Short-lived secret replay with a durable tombstone

Approve an operation-specific encrypted replay exception for `registerRiderDevice` only. Ordinary idempotency remains original-result replay.

| Situation | Required result |
|---|---|
| Same authorized principal, operation, idempotency key and request fingerprint; grant usable | Replay the original secret-bearing business response |
| Same key/namespace, changed request | 409 `IDEMPOTENCY_KEY_CONFLICT` |
| Grant expired, consumed, superseded or revoked | 409 `STATE_CONFLICT`; disclose no secret and do not execute again |
| Caller lost authority | Apply current authentication/authorization refusal before replay |
| Another principal/operation | Separate namespace; never disclose another caller's response |

The secret disclosure window ends at the earliest grant expiry, consumption, supersession or revocation. Keep the idempotency fingerprint/result references and a replay-unavailable tombstone for the ordinary 24-hour record lifetime. After that lifetime, no replay guarantee exists; normal state guards still apply. The client must never silently retry an uncertain mutation under a fresh key.

Encrypt only the response material that must be recovered. Authenticate principal, operation, record and envelope version as associated metadata. Delivery, replay and TOTP use separate key purposes and access policies. Token/challenge lookup remains hashed. Delete ciphertext transactionally on consume/revoke/supersede; enforce expiry on reads even if cleanup is delayed. The durable cleanup task is required for the promised retention, rather than indefinitely deferred to Slice-013.

The original business response is stable; request-correlation headers may describe the current HTTP request and must not be mistaken for a byte-identical whole-network-response guarantee.

Prove concurrent retry, changed body, changed authority, consume versus replay, expiry equality, failed commit, key rotation and ciphertext cleanup. Resolve the store design before S0.12, not only at S0.53 (draft S0.9 and S0.41).

## 6. F04 — Immediate permission withdrawal

Retain immutable session authorization snapshots. A security-reducing bundle edit must atomically change the bundle, terminate **all active sessions issued from that bundle**, and write the required audit record. Permission removal and narrowing of scope or authority tier count as reductions. Metadata-only edits do not. Additions/widening apply at next sign-in and any required MFA.

Retain immediate invalidation for bundle reassignment, suspension/offboarding, device revocation and loss of hub authority. Store the bundle/version lineage required to identify affected sessions. No manual second action is needed to make a reduction effective.

A protected request after commit fails with the applicable invalid-session response. Sensitive mutations coordinate their session/authority check with revocation using a documented lock order or equivalent transactional mechanism. Test both orderings: an already-authorized mutation may finish before revocation obtains its lock; a mutation that checks after revocation must not proceed. Do not promise cancellation of completed external effects.

Slice-000 provides lineage and invalidation primitives; Slice-009 implements bundle-edit operations. Test the primitive now and the real edit workflow when available. UI clears invalid sessions and returns to sign-in. Preserve historical snapshots in audit.

## 7. F05 — Recover stranded privileged MFA enrolment

Extend `resetStaffMfa` to cover a non-bootstrap privileged identity with an established password, only a PENDING factor, and no usable enrolment continuation grant. Keep the existing active-factor reset behavior.

Another authenticated Platform Admin holding `staff.mfa.reset` acts with a valid reason and required scope/tier. Self-reset and non-privileged targets remain refused. A stranded bootstrap administrator uses the controlled provisioning-resume path; do not email an unverified bootstrap destination.

Atomically invalidate old pending factors/grants, terminate target sessions with `MFA_RESET`, create the MFA_REENROLMENT grant, enqueue its F02 message and write enhanced audit. Send only to the target's verified work email. Return no seed, token or QR to the administrator.

`beginMfaReenrolment` produces a new pending factor and continuation grant. Only a valid proof activates it; no session exists before activation and subsequent ordinary sign-in. Preserve password, bundle, scope and suspension. A lost delivery must remain recoverable through bounded delivery retries or the authorized reset/reissue path. Close the intermediate-state gap explicitly: a non-bootstrap privileged target already placed into re-enrolment by an authorized reset may have no ACTIVE factor and no current PENDING factor until `beginMfaReenrolment` runs. Permit the same authorized administrator workflow to reissue that unfinished reset after its grant expires or delivery becomes terminally unusable. Require established password plus recorded reset provenance; do not broaden this to arbitrary identities without MFA. Coalesce while a usable delivery attempt is still pending, and atomically invalidate the prior re-enrolment grant when an explicit replacement is issued. This is a necessary extension of the F05 repair, preventing a second delivery-related dead end.

Prove expired continuation, self/unauthorized reset, concurrent resets, invalidated old grants, provider failure, unfinished-reset reissue before any new factor exists, suspension and successful completion. Amend AC-119, state-machine rules, response semantics and S0.37 (draft S0.27).

## 8. F06 — Database privileges and resource boundaries

### Privileges

| Database identity | Permitted scope | Excluded powers |
|---|---|---|
| API runtime | Required application DML and narrowly defined pre-auth tasks under RLS | DDL, ownership, role management, RLS bypass, audit mutation |
| Credential-delivery worker | Claim jobs, read necessary encrypted payload, update delivery bookkeeping and permitted audit | General business-table access or credential administration |
| Migration role | Reviewed schema changes | Use by a running API/worker |
| Provisioning role | Approved seed/bootstrap procedures | Presence in API/worker configuration |

Use the existing worker capability model with an explicit credential-delivery capability. Do not give a generic worker all permissions. Separate migration and provisioning processes and secrets from runtime composition.

Define each SYSTEM capability by technical principal, permitted tables/statements, lookup predicates, returned fields and composition root. `authentication`, `seed` and `provisioning` are not blanket OR conditions in every policy. A task label set by the API is not a separate database security identity: RLS mitigates missing filters, not a fully compromised runtime that possesses its credentials. Stronger separation requires actual role/function boundaries.

Close the public context-free database handle. Validate principal/surface pairings and required identifiers. Preserve transaction-local context, pool-size-one isolation, nested-transaction rejection and post-completion handle rejection. A stable SYSTEM database principal does not silently change the audit contract's nullable SYSTEM actor field; map the two intentionally.

Extend posture checks to effective schema/database CREATE, schema/object/function ownership, dangerous role membership and unexpected privileged function execution. Review PUBLIC/default privileges for future objects, controlled `search_path`, and any SECURITY DEFINER function. Such functions need fixed resolution, minimal execute grants and no arbitrary SQL parameters. Verify permissions using the actual runtime login, not the migration owner.

### Resource boundaries

Set finite acquisition, statement, lock, transaction and idle-in-transaction deadlines, plus bounded pool waiters. `lock_timeout` must fit inside statement time; transaction time must cover the intended total. Terminated/uncertain connections must be discarded. Application cancellation alone is not proof that database work stopped. No provider or verifier call holds a transaction open.

Benchmark numerical defaults in a dedicated bounded task, document the tested machine, and validate configuration relationships at startup. Production values require deployment-sized evidence; do not label local numbers universal capacity.

Effective hub access is the intersection of session reach and the specific authorizing grant. A principal-wide ALL_HUBS value never expands a restricted grant. Seed explicit all-hub scope per grant where approved, and test mixed-scope bundles.

Closure: forbidden DDL/function use/ownership, no-context access, worker cross-table denial, pool reuse, lock timeout, transaction termination/recovery, concurrent authority reduction and mixed-scope tests on real PostgreSQL.

## 9. F07 — Transport safety and business refusal order

Transport/resource admission runs before business refusal precedence. Safely admitted requests retain the specified rate-limit → authentication → CSRF → surface → permission → tier → scope → validation → idempotency → version → state → maker-checker order where those stages apply.

Reject oversized input, invalid framing, unsupported media/encoding or exhausted transport budgets promptly. Do not buffer an unbounded request to prefer 401 over 413. A small, safely bounded JSON syntax error can be carried as a parse-failure marker until its validation stage. Edge/Node parser rejection may occur before Nest and may not have the application envelope.

Slice-000 identity mutations accept UTF-8 JSON and initially reject compressed request bodies. Body limits count received bytes, including chunked requests. Specify header/body deadlines and admission concurrency. Future upload rules are separate. Bounded identifier extraction for rate limiting is permitted before full business validation; failure to extract still meets a coarse admission limit.

### Client policy

- Browser-only pre-session credential mutations require an exact configured allowlisted Origin; missing, `null` and unapproved origins fail the declared CSRF/Origin policy.
- Cookie-authenticated mutations also require the established CSRF token protection. Check Fetch Metadata for unexpected cross-site browser mutations. SameSite and CORS are additional controls.
- Native Rider operations may lack Origin under their declared native protocol; they do not accept browser-session cookies as an alternative.
- Shared operations use explicit credential modes and reject ambiguous combinations. User-Agent or a caller-supplied client-type string is never proof of native status.
- Safe read-only requests, probes and preflights do not receive a blanket Origin requirement. Opening a recovery page does not redeem the link; redemption is a protected POST.
- Credentialed CORS uses exact origins, never arbitrary reflection or wildcard permission. The trusted edge must not expose internal-only routes.

Amend C-10 operation by operation, including declared 403 behavior. Preserve the established code-free operational 5xx envelope unless an explicit contract change says otherwise; transport 413/415 must not acquire invented Error.code values.

Prove real HTTP size/framing/deadline behavior, bounded parse deferral, refusal precedence, preflight, Origin/CSRF cases and native/browser credential separation. Injected controller tests alone are insufficient.

## 10. F08 — Rate limiting, topology and bounded hashing

### Final storage choice

Use the existing limiter port, with an **authoritative PostgreSQL implementation for integrated/deployed identity flows**. A bounded in-memory adapter may serve isolated unit tests and explicit local diagnostics, but is not deployment evidence. This replaces the proposed production reliance on process memory and avoids adding Redis solely for this slice.

Use atomic per-key admission with database time, short transactions, expiry and indexed bounded cleanup. Adopt a rolling 60-second policy for each existing per-minute limit, with serialized per-key decisions; store at most the admitted timestamps needed by that bucket, or an equivalent proven bounded representation. Do not introduce a fixed-window boundary burst accidentally. Rate-limit consumption commits independently of a later authentication/business rollback. Rejections do not extend a lock indefinitely.

Keep the six existing product bucket families and their approved limits. Transport/resource ceilings are separate engineering admission controls, not new product permissions or silent edits to those six settings.

### Keys

| Bucket/use | Key decision |
|---|---|
| Staff sign-in | Canonical submitted work email, whether known or unknown |
| Privileged MFA | Bounded challenge reference bound to its principal; invalid challenges still encounter admission limits |
| Vendor sign-in | Canonical submitted account plus device-credential identity where valid; invalid/random device material cannot bypass account/coarse admission protection |
| Rider challenge and sign-in | Canonical submitted phone as already specified |
| Recovery request | Principal type plus canonical submitted identifier, whether resolvable or not |
| Grant/token redemption | Purpose-qualified digest of the bounded submitted token/grant |
| `requestAdditionalDeviceGrant` | Authenticated vendor-account principal, within `rate_limit_recovery`, in addition to its authenticated API ceiling |
| Authenticated API | Active session, with the existing operation sub-ceilings |

Namespace keys by bucket and purpose. Use a keyed digest for low-entropy identity values; no plaintext identifiers/tokens in limiter keys or metrics. Device-derived key diversification must follow proof of a recognized device; random invalid cookie values share the account's invalid-device partition rather than creating unlimited fresh buckets. Key rotation must not silently reset deployed allowance: overlap the old/new key lookup through the maximum live window before retiring the old version.

Key count, retention, memory and database growth must be bounded. Do not evict a live penalized key to admit arbitrary new attacker keys. At capacity, reject new admission uniformly and preserve existing limits. Protect the database itself with bounded local admission and edge/source limits before per-identity bucket insertion. An unavailable authoritative store fails closed for credential mutations with a documented generic operational response; no automatic permissive memory fallback.

### Expensive work and proxies

Put one bounded hash-work admission point before identity-dependent expensive branching. Include real and dummy password/PIN verification and password creation/rehash in the capacity analysis. Use asynchronous Argon2id; never synchronous hashing on the request event loop. When full, return the declared 429 `RATE_LIMITED` without verification or credential-failure increments. Initially reject immediately when no hash slot is available; do not add a waiting queue until a measured bounded policy is explicitly recorded. Account for memory per hash and shared worker-pool contention, not just CPU count.

Do not demand equal work across success, throttled, invalid-input and wrong-credential responses. Compare outwardly equivalent failure branches and test timing distributions as diagnostics. Rate-limited requests do no dummy hash. Preserve the existing per-factor counter rules.

Default direct-local `trust proxy` to false. A deployed proxy must have an explicit topology and trusted address configuration; its last trusted hop overwrites forwarded headers and the application cannot be bypassed through an alternative ingress. Never set unconditional trust merely to obtain an apparent client IP. Test spoofed forwarding and shared-NAT users.

Do not invent one universal edge requests-per-second limit here. The implementation task measures hashing, database contention, API latency and NAT behavior, supplies capacity settings and proves overflow behavior before external exposure. The business bucket limits remain fixed by their owner.

### Evidence and tradeoff

Test two API processes sharing the same buckets, restart persistence, concurrent admissions at the exact threshold, expiry, distinct-identifier floods, capacity exhaustion, store outage, key rotation, correct additional-device accounting and no counter increments on overload. PostgreSQL is appropriate to the current small platform; if measured contention is unacceptable, propose a replacement behind the port with the same semantics before increasing capacity. Do not quietly shard security allowance by instance.

## 11. F09 — Trusted HTTPS browser acceptance

Provide a repeatable trusted-HTTPS path for local/integration identity testing: one browser-facing origin serving Ops and proxying `/api/v1`, with a locally generated test CA/certificate trusted by the test browser/OS as appropriate. Keep keys outside the repository and source archives. Staging uses its real trusted TLS configuration. Do not accept `ignoreHTTPSErrors` or localhost-specific Secure-cookie exceptions as the primary evidence.

Run actual sign-in, MFA, session, CSRF, recovery and sign-out flows in Chromium, Firefox and WebKit. Add branded Chrome/Edge and actual Safari smoke/manual checks for the declared support baseline. Playwright WebKit is useful engine coverage, not proof that Safari itself was tested. Missing engines are reported blocked, not silently skipped.

Prove Secure/HttpOnly/host/path/SameSite properties, session rotation, server-side expiry/invalidation, and cookie deletion using matching scope with literal `Max-Age=0` where required. A 204 sign-out must declare its cookie mutations through the existing contract mechanism. Browser-session clearing must not inadvertently delete the long-lived vendor device-registration cookie. Native sign-out returns no browser cookies.

Session cookies can survive browser session restoration; UI must not promise that closing the browser signs the person out. Authentication acceptance includes the protected next request, not only inspecting a stored cookie.

Owns D-17, AC-127, S0.34/S0.46 (draft S0.24/S0.34) and later vendor/recovery journeys. Retain ordinary HTTP development for non-auth diagnostics only.

## 12. F10 — Truthful task dependencies and acceptance

Keep the plan practical, but remove the obligation to remain exactly 54 tasks. Split the draft's S0.30 (now S0.38 to S0.44) into bounded form/accessibility helpers, table/read states, confirmation/reason workflow, and authenticated shell/navigation work. Introduce small tasks for the worker, authoritative limiter, HTTPS harness and verifier packaging where needed.

*(The identifiers in the next table are the draft's. Current ones: plan §12.)*

| Draft claim/dependency | Required correction |
|---|---|
| S0.15 closes AC-25 before sessions | Mark platform/fixture evidence there; close the authenticated clause once real session behavior exists |
| S0.18 closes AC-26/29/44 before real operations | Keep fixture tests; require later real endpoint/principal re-verification before full closure |
| S0.41 closes AC-40 | Separate API issuance, Ops QR, Android scan/PIN and device-completion clauses; close each at its actual implementation |
| S0.46 closes AC-54 while carrying future operations | Mark implemented-operation evidence and name the future collection/evidence/payment/handover residual |
| S0.11 promises real sign-in HTTP concurrency | Use a test-only workload fixture first; repeat against real sign-in later |
| F03/D-20 appears only at S0.41 | Resolve before the S0.9 store design |
| D-24 placement resolved late | Set ports, persistence and transaction ownership before S0.2–S0.5 |
| S0.13 preserves detached completion | Replace with F02 worker/queue and crash-recovery evidence |
| S0.42 builds custom DER | Replace with F01 JVM/library qualification and integration |
| S0.50 infers coverage from test titles | Treat citation/no-skip checks as inventory only; inspect real assertions and levels |

Maintain a compact clause/evidence table with states: not implemented, fixture/platform verified, real-operation verified, client/manual evidence pending, and fully accepted. A criterion with any mandatory clause pending is not fully accepted. This replaces misleading closure language without creating a new governance system.

Preserve 37-operation/125-heading baseline inventories, then explicitly explain additions or changed clauses from these decisions. Do not freeze counts at the expense of correctness. Contract amendments precede their implementation, and each task names its direct dependencies, interfaces, smallest meaningful tests, commands, exclusions and stop conditions.

## 13. F11 — Audit integrity and required background work

Implement transactional append-only security audit with identity actions. Runtime roles cannot update/delete history; privileged action and mandatory audit succeed or fail together. Authentication failures whose counters/audit must persist return a committed failure outcome rather than throwing inside a transaction and rolling it all back.

Defer signed-checkpoint infrastructure during local feature development, but require the existing 15-minute checkpoint policy, independently protected storage, verification and alerting **before production identity use under the tamper-evidence claim**. Do not move this indefinitely behind unrelated Slice-013 functionality.

Preserve stable event identifiers, canonical serialization version, safe immutable fields and reliable batch membership. Do not use UUID/time ordering alone as proof that every committed event is included: transactions can commit out of order. A future checkpoint task must claim committed uncheckpointed events and record exact batch membership, linked manifests, signatures and independent storage receipts without serializing every business write on a global hash lock.

Evidence must detect edited/deleted events, checkpoint-chain breaks, missing/truncated latest checkpoints against an independent anchor, delayed publication and key/restore failure. Checkpoint protection is not retroactive proof of pre-checkpoint integrity. A 15-minute schedule is not a guaranteed 15-minute detection bound without monitoring and functioning publication.

The F02 delivery worker, lease recovery and secret-retention cleanup are required now because implemented behavior depends on them. Session expiry enforcement remains request-time; housekeeping never determines whether an expired session is accepted. Retention/cleanup ownership must still be explicit.

Metrics start with the existing port; expose any `/metrics` route only on a private operations boundary with route declaration, ingress restrictions and deployment authentication where needed. Labels have bounded cardinality: no emails, phone numbers, tokens, resource IDs or arbitrary URLs. Test alert triggering/recovery for delivery backlog, terminal failure, expired leases and trust-data staleness.

## 14. F12 — QR output and real handoff

Use a small reviewed, exactly pinned QR encoder and an independent test-only decoder. Selection includes maintenance, license, dependency/install behavior, CSP compatibility and output correctness; zero dependencies is a preference, not the definition of safety.

Render the actual SVG/canvas/image, decode that output independently, and compare the recovered complete payload with the expected URI. Intercepting an API response remains useful for API assertions but does not prove QR correctness. Test realistic payload length, quiet zone, sizing, contrast and zoom, then scan it with an eligible handset through the actual Rider app path.

The QR contains short-lived bearer enrolment material visible to the officer's browser and screenshots. The guarantee is that the officer never receives the rider's chosen PIN or private key. Keep QR material in transient state, clear it on expiry/navigation/completion and omit it from logs, query caches, analytics, screenshots, traces and source archives.

Default-disable trace/video/screenshot capture for secret-bearing identity test steps; retain safe diagnostics and use sentinel tests to detect accidental capture. Do not rely on visually masking a screenshot while leaving the network trace body intact.

## 15. F13 — Credential normalization and time

### Credential decision

Preserve the existing **NFKC** compatibility policy for this slice; do not change stored credential equivalence incidentally. For password/shared-secret establishment, enforce both raw-string and NFKC-normalized 12–128 Unicode-code-point bounds. Explain both in the owning contract and UI help; the raw prefilter is a real acceptance rule. For sign-in, retain no minimum and enforce the bounded raw and normalized maximum before hashing. Never trim, truncate, case-fold or echo passwords. Reject malformed Unicode consistently rather than silently encoding different bytes.

Count Unicode code points, not JavaScript UTF-16 code units. Test supplementary characters, combining sequences, compatibility expansion, equality at bounds, and four U+FB03 ligatures: their normalized length is 12 but raw length is 4, so establishment is rejected under the retained dual rule. Use the same normalization for set and verify; no browser-only transform.

Email separately retains trim → NFKC → whole-address lowercase for canonical lookup/uniqueness, no dot/plus folding, original display form retained, and explicit collision tests. Phone canonicalization follows the retained contract; do not invent one from an arbitrary locale.

Current NIST guidance recommends NFC, whereas older guidance discussed NFKC. Retaining Melarc's NFKC here is an explicit compatibility decision, not a claim of complete current NIST conformance. A later standards-adoption review must assess the whole credential policy, not silently swap one normalization function.

### Time decision

Persist instants as `timestamptz`. For expiry, grants, challenges, sessions and leases, obtain one fresh database wall-clock value **after acquiring the required locks**, and use that value for the atomic eligibility decision. Valid means `now < expires_at`; equality is expired. PostgreSQL transaction-start time is unsuitable when a request waited past expiry.

The decision point, not eventual commit completion, defines the validity test. Keep the remaining transaction short and bounded. Revalidate session/authority where required by F04. TOTP uses an injected UTC wall clock and atomic replay-step tracking under the retained skew policy. Network/process/shutdown budgets use a monotonic clock.

Tests advance/age persisted state or inject clocks; no production time-travel switch. Structural checks prohibit unapproved clock reads, but allow `new Date(value)` for parsing. Prove equality, lock-wait past expiry, concurrent consume, TOTP replay and process deadline behavior under wall-clock changes.

## 16. F14 — Platform/domain interfaces and UI ownership

Keep platform imports independent of domain implementations. Platform auth defines narrow ports for staff/vendor/rider identity lookup and permitted mutations, session storage, audit, cipher, clock, delivery and attestation. Domain modules implement their own persistence adapters. The application composition root wires adapters to ports; platform controllers never import concrete domain repositories.

The application use case owns the transaction; adapters receive the transaction handle explicitly and must not open nested transactions or hide commits. A unit-of-work/context port may live in platform without exposing the raw pool. Keep external I/O outside transactions and recheck security state afterward.

Name each port's input/output, failure outcomes, owner and transactional requirements before creating persistence. Do not duplicate identity tables just to satisfy module boundaries. Product permission domains do not prescribe every internal directory name.

Keep existing CSS tokens and UI components. Adopt a reviewed accessible primitive only when a real required interaction, such as a modal dialog, needs it. No wholesale UI-kit or styling-stack migration. Use generated transport types and one browser-client boundary preserving status, ETag and declared error details. Map errors to safe UI copy by operation/context/code, never raw exception text.

Before identity UI acceptance, prove labels/help/errors, first-invalid focus, keyboard/focus return, duplicate-submit prevention, ambiguous mutation retry with the same key, responsive density, zoom, forced colours and manual screen-reader flow. Apply the nine interface states only where meaningful and state why a state is inapplicable. Do not create fake data or placeholder permissions to demonstrate a screen.

## 17. C-01–C-10 — Final contract decisions

These IDs refer to the revision-2 Slice-000 draft, not earlier bootstrap findings that reused similar labels.

| ID | Final decision | Required proof/change |
|---|---|---|
| C-01 | Add 400 `VALIDATION_FAILED` to `approveStaffIdentity`, `reissueStaffCredentialSetup`, `reissueVendorCredentialSetup`, `resetStaffMfa`, `beginMfaReenrolment` | Owning schemas, actual field validation and precedence; preserve distinct reason errors |
| C-02 | Remove the impossible `MFA_ENROLMENT_REQUIRED` outcome from `completeStaffCredentialSetup` | Keep two-step MFA provisioning and no session before required MFA |
| C-03 | Declare `Cache-Control: no-store` on every secret-bearing response, including the three omitted ones; retain existing global no-store behavior | Header schema must constrain the value, not merely describe it; errors and cookie responses tested |
| C-04 | Key `requestAdditionalDeviceGrant` by authenticated vendor-account principal in the existing recovery bucket | Align OpenAPI, settings, feature prose and F08 implementation; never key by a grant not yet created |
| C-05 | Initial rider device registration is held by Senior Ops and Platform Admin, subject to an explicit grant and the rider's permitted hub scope | Amend the current S-only catalogue row deliberately; Platform Admin status alone is not a bypass; in-person verification remains mandatory |
| C-06 | Add bounded self-display data to Session as below | Generated client, UI navigation and all principal response tests |
| C-07 | Use purpose-specific browser routes with tokens in URL fragments | Configured origins, purpose checks, transient handling and redemption POST |
| C-08 | Use the versioned Rider QR payload below | Strict parsing and actual Android scan proof |
| C-09 | Use the exact device-key protocol below | Android/Node byte vectors and negative cases before acceptance |
| C-10 | Use F07's browser/native operation matrix | Declare relevant CSRF/Origin errors without adding them mechanically to native operations |

### C-06: Session display and navigation

Add `principal_display_name` and `authorized_hubs` entries containing only hub ID and display name, with explicit applicability/nullability by principal. Keep existing permission-key projection; do not expose bundle internals, secrets or database policy objects. Define a finite supported maximum for hub entries and reject unsupported configuration rather than silently truncate authority.

Display labels may be refreshed at `getCurrentSession`; authority remains the immutable session snapshot, with F04 invalidation. A label rename cannot grant access. Navigation is derived from permission hints and implemented route definitions, while every backend operation independently authorizes. Do not manufacture an unrestricted navigation list or expose unimplemented features because a permission exists in the catalogue.

### C-07: Link destinations

| Purpose | Browser destination |
|---|---|
| Staff credential setup | Configured Ops origin + `/setup/credential#token=<encoded-token>` |
| Staff recovery completion | Configured Ops origin + `/recovery/complete#token=<encoded-token>` |
| Staff MFA re-enrolment | Configured Ops origin + `/setup/mfa#token=<encoded-token>` |
| Vendor credential setup/recovery/additional browser | Configured Vendor origin and corresponding purpose-specific Vendor route, documented before enabling real vendor delivery |

Never derive these origins from Host, forwarded headers or submitted redirect URLs. Read the fragment once into transient state, immediately remove it with history replacement, and keep it out of telemetry. Configure no-referrer handling and no third-party content on credential pages. A reload after clearing may require reopening the message; do not persist the token in local/session storage for convenience. The server checks token purpose, principal and expiry regardless of route.

Vendor UI remains owned by the Vendor client work. API/capture-adapter tests may proceed, but sending real users to nonexistent Vendor routes is blocked. Do not route Vendor users through staff setup screens to fake completion.

### C-08: Rider QR payload

Adopt `melarc-rider://enrol/v1#token=<base64url-token>&challenge=<base64url-challenge>` as the version-1 payload. Use unpadded canonical base64url, exact scheme/host/path, exactly one of each required parameter, and strict total/field limits. The challenge encodes 32 random bytes. Token entropy and length follow the existing grant policy. Reject unknown versions, duplicate parameters, user-info, ports, extraneous fields, invalid encodings and arbitrary callback/API origins.

The preferred workflow scans inside the official Rider app and parses the payload there. The QR attestation challenge is separate from a sign-in challenge and never usable as one. The URI does not grant permission to fetch an arbitrary host. If OS link handling is offered later, review interception/app-link ownership separately: a custom URI scheme is not exclusive app identity. Package/signer attestation remains mandatory, and possessing the QR alone must not replace hardware proof.

### C-09: Device-key protocol

- Device key: hardware-backed ECDSA P-256; signing algorithm SHA-256 with ECDSA.
- Public key field: canonical standard base64 of DER SubjectPublicKeyInfo for the named P-256 curve; reject trailing DER data, wrong curves and ambiguous encodings. Parse through the reviewed crypto/library stack. Compare canonical key material with the verified attested key, not unvalidated input strings.
- Sign-in challenge: canonical unpadded base64url of 32 random bytes. Its server record binds purpose, environment/service, submitted canonical phone, eligible device context and expiry. Unknown-phone challenges retain the same outward response.
- Signed message: UTF-8 bytes of `MELARC-RIDER-SIGNIN-V1\n` followed by the canonical challenge text, where `\n` means one byte `0A`. No trailing newline and no implicit JSON serialization. This domain separator intentionally replaces the draft's bare-challenge proposal.
- `device_signature`: canonical standard base64 of an ASN.1 DER ECDSA signature. The verifier supplies SHA-256 once; do not accidentally prehash then hash again. Replay protection uses challenge state, not signature-byte uniqueness.
- Attestation challenge: decode the QR's base64url challenge to its 32 original bytes before setting the Android key-generation attestation challenge. Match those bytes against the verified attestation extension and grant hash. Sign-in and enrolment challenge namespaces remain separate.
- Signature/nonce consumption follows the retained single-use rule, including invalid proof where specified. Check expiry after locking; consume atomically so parallel attempts have one winner. PIN failure counting remains conditional on the required proof stage.

Publish executable Android and Node vectors for valid encoding, changed prefix/challenge, double hashing, DER/P1363 mismatch, wrong key/curve, invalid base64, cross-purpose replay, consumed challenge and expiry. A written protocol is not interoperability proof.

### Additional intentional contract amendments

The correction set is larger than ten after this review. Explicitly include F02's delivery acceptance and recovery coexistence, F03's secret replay exception, F04's immediate invalidation, F05's pending-MFA eligibility, F07's admission exceptions, F08's key/limiter semantics, F09's cookie mutations, F13's normalization wording, the reason seeds below and the display/key-protocol projections above.

Preserve unrelated operations. Regenerate the client and run conformance checks after the canonical contract changes. Do not hand-edit generated types or describe behavior changes as prose-only cleanup.

## 18. D-01–D-27 — Complete disposition

| ID | Final disposition |
|---|---|
| D-01 | Use `delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md`; add concise references from SLICE-000 and root CLAUDE.md to it and this decisions file |
| D-02 | Bounded tasks take precedence over exactly 54 tasks; retain traceability when splitting/renumbering |
| D-03 | Correct plan/spec first, then essential platform work and the earliest complete staff path; avoid speculative framework work |
| D-04 | Prefer suitable Node built-in crypto; asynchronous Argon2 behind a port; qualify pinned runtime behavior and cryptographic vectors. Reviewed dependencies are permitted, especially F01 |
| D-05 | Small reviewed QR encoder plus independent test-only decoder; F12 |
| D-06 | Replace custom DER/certificate validation with the private Kotlin verifier; F01 |
| D-07 | PostgreSQL-authoritative deployed limiting, bounded memory adapter for tests/local diagnostics; F08 |
| D-08 | Local substitutes are explicit; deployed secrets use external custody, versioning and purpose separation. Staging used for release proof must exercise production-like custody |
| D-09 | Defer session housekeeping/checkpoints only within F11 boundaries; bring delivery/retention workers forward because F02/F03 require them |
| D-10 | Minimal tables at first real use, forward-only migrations, complete constraints/RLS. HubAssignment remains Slice-009 and VendorAccountAllowance Slice-008; no fake behavior |
| D-11 | Seed the complete closed permission-key catalogue as inert reference data; grant only approved bundle contents needed by the slice. Unknown keys denied; future permission entries expose no routes |
| D-12 | Adopt the six identity reason domains and initial operational seeds below; fixtures remain visibly test-only |
| D-13 | Pending-only privileged MFA recovery follows F05 |
| D-14 | Additional-device key is vendor-account principal; engineering capacity values require F08 measurement before exposure |
| D-15 | Add the closed audit cause `MFA_ENROLMENT_REQUIRED` to the appropriate failed-session audit outcome; it increments no password/MFA lock counter |
| D-16 | Resolve cross-hub audit, destination selection, recovery coalescing and client ownership as below |
| D-17 | Trusted HTTPS and supported-browser evidence; no cookie-dependent skipping |
| D-18 | Bootstrap custody files outside repo with real Windows ACL/POSIX checks, two distinct custodians and resumable safe provisioning |
| D-19 | Replace detached transactions with F02 durable delivery |
| D-20 | F03 applies before generic idempotency implementation |
| D-21 | Bounded metrics and private operations exposure; F11 |
| D-22 | Explicit per-grant all-hub scope; identity hub reach is never an override |
| D-23 | Store grant scope/tier and resolve target-sensitive requirements from authoritative metadata; no client-selected privilege and no role-name shortcut |
| D-24 | Platform ports, domain adapters, composition-root wiring and explicit transaction ownership; F14 |
| D-25 | Local functional acceptance and Staging/release acceptance are separate; preserve the Staging obligation and named evidence |
| D-26 | Bounded asynchronous hash admission before identity-dependent expensive work; 429 without factor verification/counter increment on overflow |
| D-27 | Centralize safe copy by operation/context/code, including field errors; review composed screens with the owner |

### D-12: Reason catalogue

Adopt these domain names: `SESSION_REVOCATION`, `STAFF_PROFILE_REJECTION`, `STAFF_MFA_RESET`, `CREDENTIAL_ADMINISTRATION`, `RIDER_DEVICE_REPLACEMENT`, `RIDER_DEVICE_REVOCATION`.

The following are new delegated recommendations for launch seeds. They resolve the previous owner-input gap under the current instruction to finalize remaining choices. Codes are globally unique and never repurposed. These categories explain an administrative action; they do not create new permissions or bypass its existing prerequisites.

| Domain | Code | Label | Allowed use |
|---|---|---|---|
| SESSION_REVOCATION | SESSION_SECURITY_CONCERN | Session security concern | Revoke an existing session |
| SESSION_REVOCATION | SESSION_ACCESS_NO_LONGER_REQUIRED | Session access no longer required | Revoke an existing session |
| STAFF_PROFILE_REJECTION | STAFF_DETAILS_INCORRECT | Staff details require correction | Reject proposed staff identity |
| STAFF_PROFILE_REJECTION | STAFF_CREATION_NOT_AUTHORISED | Staff creation not authorised | Reject proposed staff identity |
| STAFF_MFA_RESET | MFA_AUTHENTICATOR_UNAVAILABLE | Authenticator lost or unavailable | Reset ACTIVE factor under the existing authority |
| STAFF_MFA_RESET | MFA_ENROLMENT_EXPIRED | MFA enrolment could not be completed | F05 stranded PENDING flow |
| CREDENTIAL_ADMINISTRATION | CREDENTIAL_SETUP_LINK_UNUSABLE | Setup link expired or unusable | Staff/vendor setup reissue |
| CREDENTIAL_ADMINISTRATION | CREDENTIAL_RECOVERY_ASSISTANCE | Verified credential recovery assistance | Staff/vendor exceptional recovery |
| RIDER_DEVICE_REPLACEMENT | RIDER_HANDSET_UNAVAILABLE | Rider handset lost or unusable | Verified replacement flow |
| RIDER_DEVICE_REPLACEMENT | RIDER_HANDSET_CHANGED | Rider handset changed | Verified replacement flow |
| RIDER_DEVICE_REVOCATION | RIDER_DEVICE_SECURITY_CONCERN | Device security concern | Revoke binding |
| RIDER_DEVICE_REVOCATION | RIDER_DEVICE_NO_LONGER_AUTHORISED | Device no longer authorised | Revoke binding |

Seed these twelve code rows. For all twelve: `active=true`, `valid_checkpoints=null`, `consumes_delivery_attempt=false`, `attribution=MELARC`; `requires_photo`, `requires_contact_attempt`, `requires_approval`, `requires_ops_review` and `requires_escalation` are false. `requires_note=false` initially, avoiding inventing request fields or hidden approval workflows. Existing mandatory verification notes, permissions and maker-checker rules remain mandatory independently of reason metadata. Administrative attribution identifies the workflow owner, not a finding that Melarc caused a lost handset.

Enforce the Allowed use mapping so a setup-reissue reason cannot be used for exceptional recovery. Snapshot code and label in audit. Do not provide a generic OTHER escape hatch initially. New operational categories can be deliberately added later. Amend the existing 'names proposed / no seeds supplied' prose and seed tests.

### D-16: Remaining operational choices

1. **Cross-hub audit:** apply the boundary audit to any authorized staff cross-hub read, including approved HQ/Finance access, not only a role literally named Platform Admin. Use the actor's primary hub as the comparison baseline. Keep narrow existence signals staff-only, permission/tier-gated and never available on list probes. For lists within this slice, write one bounded event per represented foreign hub without record contents; the event refers to that Hub and records the operation, and the audit object-type catalogue must explicitly admit this shape; for a detail, one event identifying the record and hub. This is an intentional extension of the existing audit rule, requiring schema/event tests, not a quiet interpretation.
2. **Delivery channel:** staff use verified work email. Vendors use the registered `delivery_channel` chosen at approval when both phone and email exist. No automatic fallback to another channel or requester-supplied address. A channel change requires its own authorized workflow.
3. **Administrative recovery repetition:** F02's coalescing and bounded live-link policy also applies to administration; metadata and audit distinguish a coalesced request from a newly queued one. No recovery request silently invalidates a usable link just because another message is queued.
4. **Client ownership:** Slice-000 owns the implemented API and Ops flows. Vendor-browser and Rider-client clauses retain explicit owners/evidence gates. A protocol fixture proves backend behavior, not real client completion. Real Vendor delivery and Rider rollout wait for their usable client paths.

### D-08/D-18: Keys and provisioning

Purpose-separate TOTP, credential delivery, secret replay, limiter pseudonymization and password pepper material. Version envelopes and verification parameters. Old key versions remain available only for the records they must decrypt/verify; test rotation and recovery. Production must reject absent keys and test adapters. Do not claim environment variables alone provide KMS-backed custody.

Generate bootstrap custody bundles with exclusive creation, outside source/archive roots, and never print secrets. On POSIX enforce restrictive ownership/mode; on Windows inspect the resulting ACL and refuse broad inherited access rather than treating chmod as sufficient. Split each custodian's material, validate distinct human identities, and document secure handoff and deletion. Resume provisioning must recover an interrupted bootstrap without creating another privileged identity or resetting completed MFA.

Because dependency-free generation/description commands construct the app, provide a safe describe composition that never connects, delivers messages or resolves secrets. This is not a production bypass. Update configuration validation, examples, redaction, docs and tests consistently; any exception allowing a necessary secret-related key name must never permit a secret value in examples.

## 19. Revised execution and handoff

### Immediate next task: amend specifications and produce the plan

Claude's first bounded task is **documents and contract reconciliation only**, with generated-client updates and focused checks where contract edits require them. Do not begin identity application implementation in the same task.

Deliver:

1. This decisions file at its intended path, with practical CLAUDE.md and Slice links.
2. A concrete owning-file amendment map covering every F/C/D disposition and changed acceptance clause.
3. Revised specifications and canonical OpenAPI with regenerated client where needed; no contradictory old claims remaining on these paths.
4. `SLICE-000-IMPLEMENTATION-PLAN.md`, with small executable tasks, real dependencies and accurate evidence levels.
5. A concise report of changes, executed checks, remaining environment prerequisites and the single next task.

If the combined contract amendment is too large for a reviewable task, split it into numbered bounded substeps with explicit dependencies. Do not use splitting to start code before its governing behavior is settled.

### Implementation order

- Reconcile specifications, permission/reason seeds, wire protocols and plan.
- Establish ports/config/crypto, DB privilege/context/deadlines and test kit.
- Implement audit/idempotency, authoritative limiting and bounded hashing.
- Implement durable credential delivery and cleanup before credential-issuing operations.
- Establish trusted HTTPS and required accessibility foundation.
- Complete staff setup/sign-in/MFA/session vertical flow, then administration and recovery.
- Complete Vendor API behavior and clearly owned client work.
- Qualify/private-package the attestation verifier and implement Rider enrolment/sign-in/revocation with byte-level and real-device evidence.
- Finish composed UI, security/contract sweeps, operator walkthrough and deployment prerequisites.

Reorder independent tasks where justified, but preserve dependencies and one-task handoffs. The exact legacy S0 numbers may change; provide an old-to-new map.

### Per-task evidence

Report actual HEAD and diff scope, files changed, decisions implemented, test commands and exit results, fixture versus real-operation evidence, unrun/manual checks and residual owners. Keep logs/artifacts free of secrets. No blanket staging, reset, clean, commit, push or merge is authorized by this document.

Run the existing static/build/contract/client checks appropriate to the task; database changes require real `test:db`, UI changes the relevant browser suite, and journeys `test:e2e`. `pnpm test` alone is not the entire gate. Windows signal skips need Linux/CI evidence. Do not rewrite a failing assertion merely to match a defective implementation. Mutation probes should target meaningful controls rather than inflate counts.

## 20. Closure and release matrix

| Evidence | May be deferred during local development? | Must exist before |
|---|---|---|
| Plan/spec reconciliation and real dependency map | No | Affected implementation |
| DB role denial, RLS/context isolation and transaction deadlines | No once identity persistence begins | Exposed identity endpoints |
| Durable delivery restart/ambiguity/secrecy proof | No once messages are implemented | Real credential delivery |
| Shared limiter, bounded hashing and proxy/load evidence | Unit substitutes only | External authentication exposure |
| Trusted HTTPS, actual cookie journeys and required engine coverage | While building foundations | Browser identity acceptance |
| Manual keyboard/screen-reader and supported-browser checks | Until composed flow exists | Acceptance of the first real identity UI |
| Real internally signed Android device proof | API substitutes allowed for development | Rider enrolment rollout |
| Vendor and Rider client journeys | Owned client work may follow API work | Claiming those client clauses complete or exposing their workflows |
| Signed audit checkpoints, independent storage and monitoring | Yes for local feature work | Production identity use |
| Real secrets/provider configuration and restore/rotation rehearsal | Local substitutes allowed | Staging release evidence and production |
| Clean-machine/hosted CI/artifact/branch evidence | Preserve named bootstrap waivers only | Milestone to which each waiver applies; no automatic release waiver |

No finding is 'fixed' solely because its recommendation is in this file. Closure requires the specified implementation and evidence. A local functional walkthrough can accept demonstrated local behavior; it does not waive the retained Staging or production obligations.

## 21. Source references and interpretation

Repository and draft citations throughout identify the actual baseline under review. External sources below support technical mechanics; Melarc-specific choices such as PostgreSQL-backed limiting, two live recovery links and the reason seeds are engineering/product recommendations under the owner's delegation, not prescriptions attributed to those sources.

Consulted 8 October 2026:

- Android attestation verification: https://developer.android.com/privacy-and-security/security-key-attestation — hardware/root/revocation verification and rootward extension handling.
- Android Kotlin verifier: https://github.com/android/keyattestation — verifier interface, policy constraints and challenge integration. Qualify the exact pinned release rather than treating the example configuration as Melarc policy.
- Node pinned crypto reference: https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html — crypto interface/encoding behavior; pin and test the actual runtime.
- PostgreSQL time functions: https://www.postgresql.org/docs/18/functions-datetime.html — transaction-start time versus advancing wall time.
- PostgreSQL timeouts: https://www.postgresql.org/docs/18/runtime-config-client.html — statement, lock, transaction and idle transaction controls.
- PostgreSQL privileges: https://www.postgresql.org/docs/18/ddl-priv.html — object privileges and ownership implications.
- PostgreSQL atomic conflict handling: https://www.postgresql.org/docs/18/sql-insert.html — concurrency tools; the complete limiter still requires multi-process tests.
- Express proxy trust: https://expressjs.com/en/guide/behind-proxies/ — trust configuration and spoofable forwarded headers.
- Playwright browsers: https://playwright.dev/docs/browsers — engine/branded-browser support and distinction from installed Safari.
- OWASP recovery: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html — uniform recovery responses and bounded single-use credentials.
- OWASP CSRF: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html — Origin, Fetch Metadata and layered browser controls.
- OWASP resource protection: https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html — bounded requests and expensive work.
- OWASP logging: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — sensitive-data exclusion and log protection.
- NIST current authenticator guidance: https://pages.nist.gov/800-63-4/sp800-63b.html — current Unicode recommendation; this document makes no blanket NIST compliance claim.

## 22. Final implementation boundary

Retain bootstrap. Replace unsafe or incomplete decisions explicitly. Build one bounded task at a time, preserve newer work, and report evidence truthfully. A remaining measurable deployment choice is a named prerequisite with an owner and proof requirement, never permission for an agent to silently choose a different architecture or declare the system universally green.
