# SLICE-000 capacity report (S0.65)

**Status: measurements and proposals. This report changes no setting.** It records what one run measured on one machine, calibrates the development-qualified values against it, and proposes what the Product Owner may approve ([settings.md](../../contracts/settings.md) §9). A measured engineering value is proposed here; a product value (how many people sit behind one address, how fast a hub signs in at the start of a shift) is the owner's and is an input below, never a default. **The machine is a developer's workstation that other projects share, so every number is indicative: a throughput here is a lower bound on a quiet server, and a latency an upper bound**; the deployed topology's evidence is release gate G2.

Run on 28 October 2026 (the measuring is `apps/api/test/database/alone/capacity-benchmark.db.test.ts` and `apps/api/dist/tools/benchmark-argon2.js`; how to repeat them is [DEVELOPMENT.md](../../DEVELOPMENT.md#the-two-build-proof-the-concurrency-run-the-alert-rehearsal-and-the-capacity-measurement)).

## 1. The machine and what ran

| Fact| Value|
|---|---|
| Machine| Windows 11 Pro 10.0.26200, Intel Core i7-8750H at 2.2 GHz (12 logical processors), 16,300 MiB. The development servers of other projects were idle; nothing else of this project ran|
| Runtime| Node 24.21.0 (OpenSSL 3.5.8); the libuv pool at its default of 4 unless said|
| Server| PostgreSQL 18.6 on x86_64-windows, native, on the same machine|
| Under test| The compiled API as its own process, as the runtime login, in production mode (no response check), over real HTTP from another process; `HASH_ADMISSION_SLOTS` 2, `HASH_ADMISSION_MEMORY_BUDGET_MIB` 256, `DATABASE_POOL_MAX` 10, `DATABASE_POOL_MAX_WAITERS` 50, `HTTP_ADMISSION_CONCURRENCY` 64, Argon2id 64 MiB, 2 passes, 1 lane|

## 2. What was measured

**The single hash** (`benchmark-argon2.js`, 15 runs, one at a time): the cost of one derivation.

| Memory (KiB)| Passes| Median (ms)| p95 (ms)|
|---|---|---|---|
| 19,456 (the floor of Staging and Production)| 2| 41.9| 50.5|
| 19,456| 3| 66.9| 80.8|
| 32,768| 2| 73.7| 99.7|
| 46,080| 1| 59.1| 73.9|
| **65,536 (configured, development-qualified)**| **2**| **156.5**| **188.2**|
| 65,536| 3| 197.2| 315.7|
| 131,072| 2| 285.3| 364.8|

**The staff sign-in** (a verification behind hash admission, the policy locks and a session issue), each stage a different member of staff, so no per-identity bound decides the figures. "Refused" is an answer that is not the sign-in.

| Concurrency| Signed in| Refused| Median (ms)| p95 (ms)| Sign-ins a second| Answers|
|---|---|---|---|---|---|---|
| 1| 30| 0| 204| 263| 4.7| 200|
| **2**| **30**| **0**| **213**| **252**| **9.0**| 200|
| 4| 4| 26| 282| 302| 7.9| 4 × 200, 26 × `429 RATE_LIMITED`|
| 8| 4| 26| 309| 386| 7.5| 4 × 200, 26 × `429`|
| 16| 4| 44| 408| 432| 6.6| 4 × 200, 44 × `429`|
| 32| 4| 92| 718| 777| 4.7| 4 × 200, 92 × `429`|
| 64| 4| 188| 669| 778| 4.3| 4 × 200, 85 × `429`, 103 × `503`|

The stage saturates at **two** at once, which is the number of hash slots: a request that finds no slot is refused **at once** (`RATE_LIMITED`, deriving nothing) and is not queued ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4c). More slots, tried on the same machine:

| Hash slots (libuv pool)| Best sign-ins a second| At concurrency| Median at that point (ms)|
|---|---|---|---|
| 2 (4)| 9.0| 2| 213|
| 3 (4)| 10.4| 4| 305|
| 4 (8)| 12.9| 4| 299|

**An authenticated read** (`getCurrentSession`, 24 sessions so that none passes its own limit) and **a refusal at the guard** (a request with no session):

| Concurrency| Reads a second| Read median / p95 (ms)| Read answers| Guard refusals a second| Refusal median / p95 (ms)|
|---|---|---|---|---|---|
| 1| 49.6| 20 / 26| 400 × 200| 1,134| 1 / 1|
| 4| 123.9| 30 / 46| 400 × 200| 2,200| 1 / 3|
| 16| 126.4| 123 / 153| 400 × 200| 2,987| 5 / 8|
| 64| 77.7| 726 / 749| 60 × 200, **340 × `503`**| 2,099| 23 / 63|

**One session past its general limit** (`rate_limit_authenticated_api`, 120 a minute for each session): 160 requests in a row were 120 × 200 and 40 × `429 RATE_LIMITED`, with a median of 19.9 ms over all 160 (the refusals were not timed apart from the answers).

**The session answer as the number of hubs rises** (a session of the all-hub scope, whose answer lists every hub and is never truncated):

| Hubs| Answer (bytes)| Median (ms)|
|---|---|---|
| 1| 447| 23.4|
| 10| 1,158| 24.9|
| 100| 8,358| 24.2|
| 1,000| 81,258| 40.2|

## 3. What the measurements say about each value

**The deadlines are far from binding.** No stage's p95 was above 778 ms (the largest in the tables; the maxima of the stages are in the run's JSON, and a stage of four answered sign-ins or fifteen hashes has a p95 that is its largest value). Nothing waited anywhere near the 5,000 ms acquire timeout, the 5,000 ms statement timeout or the 15,000 ms request budget: past what the machine serves, the API **refuses** (a `429` from hash admission or a limit, a `503` from a bound) and does not make anyone wait. The sign-in's server-side p95 of 252 ms at two at once is the diagnostic server latency of [OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §5.1, recorded beside its target and never in place of it: the target of 3 seconds for a normal action is measured at the user's action over the 150 ms fixture, which is G2's, and this report does not set the one against the other.

**Argon2id.** The configured profile (64 MiB, 2 passes) takes a median of 157 ms here against the development convention of 100 ms; the floor profile takes 42 ms. S0.16 measured 122 ms on a quieter day, so the figure moves with the machine's state. **Proposal: no change to the profile now.** The cost that matters is the deployed machine's, which only G2 measures; the floor (19,456 KiB, 2 passes) is what Staging and Production already refuse to go below.

**Hash admission.** Throughput rises with slots but less than the slots do: 9.0, 10.4 and 12.9 a second for two, three and four, because each hash holds 64 MiB and the memory system, not the processor, is what they share. Four slots take the whole 256 MiB budget. **Proposal: keep two slots until the deployed machine is measured** (the number is a property of its memory bandwidth and cores), and keep the rule that a request with no slot is refused at once. The proposal that **is** measured: where more sign-in capacity is wanted, four slots with a libuv pool of eight give about 43% more on this machine, each sign-in taking about 40% longer (299 ms against 213 ms) because the hashes share the memory.

**The pool and the HTTP admission ceiling disagree.** The pool holds 10 connections and 50 waiters, so at most **60** requests that need the database can be in the API at once; `HTTP_ADMISSION_CONCURRENCY` lets **64** in. At 64 at once, 340 of 400 reads were refused `503`, and **the API's own log names every one: `PoolSaturatedError: the database pool is saturated: 50 callers are already waiting for a connection`** (exactly 60 were served, the pool and its waiters); 103 of the sign-ins at 64 were refused `503` too, whose cause that run did not record. They were refused by the pool's bound, not held at the edge for the 2 seconds admission allows. **Proposal: an admission concurrency not above the pool and its waiters (for example 48, leaving room for the probes and a margin)**, so that overload is a wait at the edge that ends in a refusal there, not a failure inside. It is an engineering parameter and a one-line configuration change; this report does not make it.

**The limiter.** The general authenticated limit does what it says (the 121st request of a session in a minute is refused at once, at the speed of an answer). **A request with no session is not limited at all** at the guard (the guard has no key for it): 400 in a row at concurrency 64 were each refused `401` in 23 ms median, 2,000 to 3,000 a second. That is cheap, and it is also unbounded: the protection against a flood from one address is the **per-address edge ceiling, which is not configured** (settings.md §9), and external exposure waits for it (G2).

**Many people behind one address (NAT).** What bites first for a hub is not a per-address ceiling but hash admission: two sign-ins at once. With the measured capacity of about 9 sign-ins a second (540 a minute), the owner's figures give the need:

| People behind one address| Signing in within (minutes)| Needs (sign-ins a minute)| Share of the measured capacity|
|---|---|---|---|
| 20| 5| 4| 0.7%|
| 100| 5| 20| 3.7%|
| 300| 10| 30| 5.6%|

**These three rows are examples of the question, not the owner's figures.** The need is small beside the capacity; the burst is the issue: more than two people pressing sign in in the same moment get a `429` and must press again, and a burst of twenty clears in about two seconds if each tries again at once. **Whatever per-address ceiling the owner sets must be at least the sign-ins a minute the largest shift needs (the table's third column) with a margin**, and the sign-in page's wording for a `429` is a product matter to check against the measured behaviour (not examined here).

**Hubs in a session's answer.** The answer grows by about 81 bytes a hub and its latency is flat to 100 hubs (24 ms) and 40 ms at 1,000 (81 KB). **Proposal for the maximum number of hubs per session (settings.md §9): 100**, inside the flat region; 1,000 would cost about ten times the bytes (81,258 against 8,358) for no gain in anything measured. Whatever the owner chooses, the contract takes it by a deliberate change, as §9 says.

## 4. For the owner to decide

1. The **per-address edge ceiling** ([settings.md](../../contracts/settings.md) §9): the owner's figure for the largest shift behind one address, from the table above. Until it is set, external authentication exposure waits (G2).
2. The **hash-admission capacity** and **Argon2id profile** for the deployed machine: keep two slots and the configured profile until G2 measures the deployed hardware, or approve four slots with a pool of eight where more capacity is wanted.
3. **`HTTP_ADMISSION_CONCURRENCY`**: bring it to or below the pool and its waiters.
4. The **maximum number of hubs per session**: 100 proposed.
5. **An alert on hash admission being full** (`rate_limited_total` with the cause `HASH_ADMISSION_FULL`, which [OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §3 leaves as a counter until this task proposes one). What the measurement gives is the behaviour, not a threshold: more than two sign-ins at the same moment are refused at once and clear when pressed again, and from four at once the stage refused most of what it was sent. **What share of sign-in attempts may be turned away, and for how long, before a person is told, is the owner's;** no rule is written until it is set.
6. **Whether the per-address edge ceiling covers every operation that takes a grant or a token, or only some** ([settings.md](../../contracts/settings.md) §9). The capacity measured is the staff sign-in's; the setup, recovery and device-grant requests do cheaper work behind the same kind of key (a grant or a token the caller chooses), and were not measured.

## 5. What this does not show

- **A quiet machine.** The workstation was shared and the figures move with its state; the single-hash median differs from S0.16's by a third. Run again on the deployed machine.
- **The deployed topology**: an edge, several instances and a network between them are G2.
- **A sustained load.** Each stage is seconds long; a leak, a growing table or a cleanup falling behind would not show.
- **The delivery worker's own capacity.** [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) says the worker's figures are measured against this report; nothing of the worker (S0.18) was measured here, only its backlog gauge, in the alert rehearsal.
- **The Rider and Vendor sign-ins.** The staff sign-in was measured; the Vendor's does the same hash under a different bucket, and the Rider's adds a signature check, with no reason to differ in kind, but they were not measured.
- **The proof that the refusals are the designed ones** beyond the answers each stage recorded: the `429` and `503` counts are the evidence, and the log of the run holds no request content.
