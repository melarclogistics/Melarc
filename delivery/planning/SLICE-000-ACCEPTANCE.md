# SLICE-000 local acceptance record (Gate 8, S0.70)

**Status: the walk of rows 1, 2 and 12 is reported done by the Product Owner (28 October 2026). The record is not signed, and Gate 8 is not passed.** What the walk showed is the owner's report, and this record states no more than that report. It was prepared on 28 October 2026, with S0.62 to S0.69 built, so that the Product Owner's walk of [SLICE-000.md](../slices/SLICE-000.md) §5 can be done against one page and written down on it. **The tree walked** is the working tree of `feat/slice-000-s0-29` as it stood on 28 October 2026, before it was committed: the tree of the Stage 8 work, without the date field's library wiring (React Aria Components), which came after the walk and has not been walked ([the plan's §7.50](SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026)). The walk is the owner's evidence (run code M E); this record is not a substitute for it, and it is not the Staging walk or any of the release gates ([the plan's §7.2](SLICE-000-IMPLEMENTATION-PLAN.md#72-release-gates--not-acceptance-of-this-slices-code)).

## 1. The walk: rows 1, 2 and 12, from a clean environment

The commands are [DEVELOPMENT.md](../../DEVELOPMENT.md)'s; this page names the sections and gives none, so that they cannot drift. A clean environment means a database that nothing has used.

1. **Make it clean.** Stop the API, the worker and the portal's dev server. Reset the local database as [section 8](../../DEVELOPMENT.md#8-reset-to-a-known-state) says: it destroys what the local database holds, so it is yours to run. Then build, migrate, seed and run the bootstrap with the two custodians as sections [4](../../DEVELOPMENT.md#4-build-and-migrate) and [5](../../DEVELOPMENT.md#5-run-the-applications) say, with a new, private custody directory outside the checkout.
2. **Start the three processes**, the API, the delivery worker and the portal, as [section 5](../../DEVELOPMENT.md#5-run-the-applications) says. Open the portal at `http://127.0.0.1:5172`, not `localhost`: the API accepts only the origin in `OPS_ORIGIN`.
3. **First sign-in** ([First sign-in](../../DEVELOPMENT.md#first-sign-in)): each administrator opens their own bundle, chooses a password and adds an authenticator. Both are Platform Admins with an all-hub grant.

**Row 1: an Ops Staff setup and login** (`AC-SLICE-000-115`, `-33`, `-85`, `-86`, `-87`, `-01`).

| Step| Do| Expect|
|---|---|---|
| 1.1| Signed in as the first administrator: Staff, then Add a staff profile. Choose the Ops Staff bundle from the list the page offers, a work email you can read, a hub| The profile is `PENDING_APPROVAL` (the page says it cannot sign in until it is approved); the maker is never asked for a credential|
| 1.2| Sign out. As the **second** administrator, find the profile and approve it with the version the page read| The profile is `ACTIVE`; a setup link is sent|
| 1.3| Read the link from the worker's capture folder (`~/.melarc/capture`, or `DELIVERY_CAPTURE_DIRECTORY`) and open it| A page to choose a password of 12 to 128 characters; the link carries no password|
| 1.4| Choose your own password; sign in at the sign-in page| A session; the landing page; no authenticator was asked for|

**Row 2: a privileged setup and login** (`AC-SLICE-000-02`, `-32`). Make a second profile with the **Senior Ops** bundle and approve it as above.

| Step| Do| Expect|
|---|---|---|
| 2.1| Open its setup link, choose a password| The page goes on to an authenticator: **no session yet**|
| 2.2| Scan the code or type the key into an authenticator app; enter the six digits| The factor is proven|
| 2.3| Sign in with the password| A second step asking for a code; **no session cookie** until it is given|
| 2.4| Enter a code| The landing page; a session|

**Row 12: a lapsed grant is re-issued** (`AC-SLICE-000-89`, `-120`). A setup link lives **30 minutes** (`recovery_link_ttl_minutes`), so this row is walked by waiting, not by changing anything:

| Step| Do| Expect|
|---|---|---|
| 12.1| At the start of the walk, make a third profile (Ops Staff) and approve it. **Do not open its link**| A setup link is in the capture folder|
| 12.2| After 30 minutes, open that link| The page refuses it as not valid, and says nothing more|
| 12.3| As an administrator, open the profile: send a new setup link, with a reason| A second message in the capture folder; the first stays dead|
| 12.4| Open the new link and set a password| Set up as in row 1|
| 12.5| Open the profile of an administrator or of anyone who already has a password: try to send a new setup link| Not offered, or refused: such an identity is recovered, not set up again (`AC-SLICE-000-120`)|

**Write down** for each row: done or not, what differed from what is expected, and the date. A row that cannot be walked stops this record ([the plan's S0.70](SLICE-000-IMPLEMENTATION-PLAN.md#s070--local-functional-acceptance-walk-gate-8)).

| Row| Walked on| Result| Notes|
|---|---|---|---|
| 1| 28 October 2026| Completed, as reported by the Product Owner| None reported|
| 2| 28 October 2026| Completed, as reported by the Product Owner| None reported|
| 12| 28 October 2026| Completed, as reported by the Product Owner| None reported|

**Signed:** ______________________  **Date:** ____________

*Reported by the Product Owner in the session of 28 October 2026, in the words "I have completed 1, 2 and 12". The signature is the owner's, and it is not given here.*

## 2. What the tests cite, criterion by criterion

The criteria of the five feature files and the tests that cite them: `scripts/slice-000-citations.ts` holds the inventory (133 criteria, every one cited by a test that runs; it prints the count and the problems, and a test holds it to the repository). **The Kinds and Files columns were written from that inventory's citations on 28 October 2026 by a one-off script that is not kept: they are an aid to reading, and nothing regenerates them.** **A citation is an inventory, not a proof**: whether a test proves what it cites is reviewed in each task's handoff. **The evidence state of each criterion** (fixture or platform verified, real-operation verified, or the owner's), which S0.70 asks of this record, **is owed and is not here**: the plan's [§6](SLICE-000-IMPLEMENTATION-PLAN.md#6-traceability) gives the task that completes each criterion and the handoffs the evidence, and joining them into one column for the owner to sign against is the work that remains. The kinds are: *route* (the real operation over HTTP on a real PostgreSQL), *journey* (the integrated harness: real screens, API, database and worker), *browser* (an Ops Portal page in a real browser against stubs), *screen* (a component test), *database* (a schema or policy test as the runtime login), *unit*.

| AC| Feature| Criterion| Kinds of test| Files|
|---|---|---|---|---|
| `01`| staff| Ops staff sign in with email and password| route, screen| 2|
| `02`| staff| A privileged role cannot sign in without a second factor| route, browser, screen| 5|
| `03`| staff| The challenge is single-use, short-lived and grants nothing| route, screen, database| 4|
| `04`| staff| Sign-in failure does not disclose account existence| route, browser, screen| 3|
| `05`| staff| Authorization tests permissions, never role names| route| 3|
| `06`| staff| The bundle is snapshotted at session issue| route| 1|
| `07`| staff| Ordinary staff cannot reach another hub, and are told why| route, database| 2|
| `32`| staff| An approved privileged identity cannot sign in before MFA is proven| route, journey| 2|
| `33`| staff| The maker never supplies a credential| route, screen, database| 3|
| `35`| staff| A browser session expires on idle| route, journey, database, unit| 8|
| `77`| staff| A fifth wrong password locks the credential and nobody is told| route, screen| 3|
| `78`| staff| A lock ends on its own and a correct sign-in resets the count| route| 2|
| `79`| staff| A wrong MFA code is refused and counted twice| route, screen| 2|
| `80`| staff| A lock reached at the second factor is announced only to someone who proved the password| route, screen| 2|
| `81`| staff| A rate-limited request is neither verified nor counted| route, journey, screen, unit| 4|
| `82`| staff| Signing out ends the session| route, database| 2|
| `83`| staff| The current-session read returns no credential and no bundle contents| route, journey, database| 4|
| `84`| staff| An unsafe request without the synchronizer token is refused and audited| route, journey| 3|
| `85`| staff| A maker below the Platform Admin tier cannot approve, a Platform Admin can, and a bundle above the approver's tier needs a Platform Admin| route, journey| 2|
| `86`| staff| An approver finds a pending identity and approves the version they read| route| 1|
| `87`| staff| A password outside 12 to 128 characters is refused, and nothing else is required| route, journey, screen| 6|
| `88`| staff| A setup grant is single-use, and two completions have one winner| route, screen| 2|
| `89`| staff| A lapsed setup grant is re-issued, and an identity that already has a credential is refused| route| 1|
| `90`| staff| An approval whose message cannot be queued rolls back, and a later provider failure does not| route| 2|
| `91`| staff| A failed sign-in is audited with its precise cause and answers the same to everyone| browser, screen| 2|
| `92`| staff| The bootstrap secret is consumed when the password is set and can never start MFA enrolment| screen, database| 3|
| `93`| staff| An expired continuation grant is recovered by a provisioning mechanism no API operation or screen can invoke| database, unit| 6|
| `94`| staff| A wrong enrolment code leaves the factor PENDING| screen| 1|
| `115`| staff| The creation screen offers the bundles the contract returns, and none of its own| journey| 1|
| `116`| staff| The bundle read needs its own key, and neither staff.identity.create nor permission.read substitutes| route| 1|
| `117`| staff| Choosing a privileged bundle grants nothing, and the list reveals no authority| route| 1|
| `118`| staff| The bootstrap is exactly two identities, and the first profile one makes either may approve| journey, database| 3|
| `122`| staff| A pending profile is rejected by a different approver, at the tier its bundle needs, and its email is released| route| 1|
| `123`| staff| A privileged identity with no ACTIVE factor reaches the second step and is stopped there| route, journey, screen| 3|
| `126`| staff| A TOTP code is six digits, single-use and accepted one step either side| route, screen| 3|
| `127`| staff| The session cookies carry no lifetime of their own and the vendor device credential lasts 400 days| route, journey| 5|
| `129`| staff| A work email has one canonical form| route| 1|
| `133`| staff| A proven code, asked to be remembered, issues a bounded trusted-browser credential| journey, database| 3|
| `134`| staff| A trusted browser skips the second factor and nothing else| journey, screen, database| 4|
| `135`| staff| A trusted browser ends when the thing it vouched for changes| journey, database| 4|
| `136`| staff| A person lists and removes their own trusted browsers| journey, screen, database| 4|
| `137`| staff| A Platform Admin removes another person's trusted browsers, with a reason| journey, screen, database| 4|
| `138`| staff| The screens offer the choice, honour it and let the person manage it| journey, screen, database| 5|
| `139`| staff| The credential is never kept where it can be read| journey, screen, database, unit| 5|
| `08`| rider| Phone, PIN and registered device are all required| route, journey| 2|
| `09`| rider| A caller who has not proved the PIN learns nothing about a rider's device| route| 1|
| `10`| rider| One live session per rider| route, journey, database| 3|
| `11`| rider| Inactive riders cannot sign in, and cannot tell why| route| 1|
| `46`| rider| A revoked rider session is invalid on the very next request| route| 1|
| `13`| rider| Re-registration is never self-service| route| 2|
| `38`| rider| A rider's phone and PIN without the registered key do not authenticate| route| 1|
| `39`| rider| The challenge endpoint does not enumerate riders| database| 1|
| `40`| rider| First registration never exposes the PIN to the officer| route, journey, screen| 4|
| `47`| rider| Sign-in does not depend on how the APK was installed| route| 1|
| `48`| rider| A revoked device cannot sign in| route| 1|
| `49`| rider| A replaced handset can no longer sign in| route| 1|
| `50`| rider| A rider's credentials from another rider's device are refused| route| 1|
| `51`| rider| A sign-in with no device proof is refused| route| 1|
| `52`| rider| A replayed challenge is refused| route, database| 2|
| `53`| rider| An expired challenge is refused| route, database| 2|
| `54`| rider| A signed-in rider is never stranded by an attestation outage| database| 1|
| `55`| rider| No test substitute, for attestation or for message delivery, can run in production| database, unit| 4|
| `56`| rider| A root signal of DETECTED is recorded and blocks nothing| route| 1|
| `57`| rider| A root signal of NOT_DETECTED relaxes nothing| route| 1|
| `58`| rider| A root signal of UNKNOWN is valid and is recorded as UNKNOWN| route| 1|
| `59`| rider| A sign-in with no root signal is refused| route| 1|
| `60`| rider| A hardware-attested key is enrolled| route, journey, database| 3|
| `61`| rider| A handset that cannot hold a hardware-backed key is refused| route, database| 2|
| `62`| rider| Evidence for the wrong application is refused| route, database| 2|
| `63`| rider| An untrusted attestation chain is refused| route, database| 2|
| `64`| rider| Evidence for a different challenge is refused| route, database| 2|
| `65`| rider| An unlocked or unverified device is refused| route, database| 2|
| `66`| rider| A key that is not the attested key is refused| route, database| 2|
| `67`| rider| An expired, consumed or superseded grant is refused before any evidence is read| route| 1|
| `68`| rider| An enrolment with no attestation is refused| route| 1|
| `69`| rider| Stale trust data fails enrolment closed and touches nothing else| route, database| 2|
| `70`| rider| The signing certificate can be rotated| route, database| 2|
| `71`| rider| A replacement supersedes the old device atomically| route, journey| 2|
| `72`| rider| A failed replacement leaves the existing device untouched| route| 1|
| `73`| rider| A replayed or concurrent replacement has one winner| route| 1|
| `74`| rider| A revoked device stays revoked through a replacement| route, screen| 3|
| `75`| rider| The substitute verifier produces each outcome deterministically| route, unit| 2|
| `76`| rider| A rider never holds two ACTIVE devices| route| 2|
| `109`| rider| Five wrong PINs from the registered handset lock the PIN| route, journey, unit| 3|
| `110`| rider| A handset that cannot sign can neither guess the PIN nor lock the rider| route| 1|
| `111`| rider| A PIN that is not six digits is refused by the schema| route| 2|
| `112`| rider| Revocation is bounded to the actor's hubs| route, screen| 2|
| `113`| rider| The rider roster shows readiness and never a credential| route, screen, database| 4|
| `124`| rider| A rider who has had a device revoked is not registered again by registerRiderDevice| route, screen| 3|
| `14`| vendor| A new login displaces the old one, and says so| route| 1|
| `15`| vendor| No surface claims person-level attribution| route, journey, browser, screen| 4|
| `17`| vendor| A credential change terminates every session| route, journey| 2|
| `18`| vendor| The vendor surface exposes no permission management| route| 1|
| `19`| vendor| The vendor sign-in ceiling is keyed on the account and its browser| route, unit| 2|
| `45`| vendor| A second browser can be registered without displacing the first| database| 1|
| `41`| vendor| Nobody types a device identifier| route, journey| 2|
| `42`| vendor| The administrator never learns the shared secret| route| 1|
| `95`| vendor| Five wrong secrets from a registered browser lock the credential for everyone| route, journey| 2|
| `96`| vendor| An unregistered browser can neither sign in nor lock the account| route, journey| 2|
| `97`| vendor| A shared secret outside 12 to 128 characters is refused| route| 2|
| `98`| vendor| The account identifier arrives with the grant and is not a secret| route| 1|
| `99`| vendor| Platform Admin can end a shared vendor session, and Senior Ops cannot| route, journey| 2|
| `100`| vendor| A vendor sees and removes its own browsers, never the one it is using| journey, database| 2|
| `101`| vendor| A lapsed vendor setup grant is re-issued by approval authority| route, database| 2|
| `102`| vendor| An Ops reader sees an account's readiness within their grant, and never a credential| route, database| 4|
| `20`| recovery| Recovery goes only to a registered channel, and a supplied destination is rejected| route, screen| 2|
| `21`| recovery| Recovery does not disclose whether an account exists| route, screen| 2|
| `22`| recovery| Completing recovery terminates every session| route, journey, screen| 3|
| `23`| recovery| Recovery authority is split and enforced| route, journey, browser| 4|
| `24`| recovery| Recovery does not lift a suspension| route| 1|
| `36`| recovery| Password recovery leaves the MFA factor untouched| route, journey, screen| 3|
| `37`| recovery| MFA reset requires another Platform Admin and cannot disable MFA| route| 1|
| `103`| recovery| An expired, consumed or malformed recovery link is one answer| route, browser, screen| 3|
| `104`| recovery| Recovery requests are rate-limited without disclosure| route, screen, unit| 3|
| `105`| recovery| Platform Admin starts staff recovery, and the new password reaches nobody| route, journey, browser, screen| 5|
| `106`| recovery| A completed recovery clears a lock| route| 1|
| `107`| recovery| A failed recovery message is invisible to the caller and is a job outcome| route| 1|
| `108`| recovery| A device re-registration records why, and how identity was verified| route, journey, screen| 3|
| `119`| recovery| MFA reset refuses a self-reset and a non-privileged identity, and reaches a stranded or unfinished enrolment| route| 1|
| `120`| recovery| A bootstrap identity cannot be re-issued a setup grant, and the resume command is not a standing way in| journey, database| 3|
| `121`| recovery| A repeated recovery request changes nothing it should not and reveals nothing| route| 3|
| `125`| recovery| The credential setup operations share the recovery bucket| route, unit| 3|
| `25`| permissions| A route with no declared permission is refused| unit| 1|
| `26`| permissions| Both gates are independent| route, database| 3|
| `29`| permissions| Authorization returns only its own codes, never an authentication code| route, database| 4|
| `30`| permissions| Hub scope is enforced structurally| route, database| 4|
| `43`| permissions| Anonymity is declared, never inferred| unit| 2|
| `44`| permissions| 401 and 403 are different answers to different questions| route, database, unit| 9|
| `114`| permissions| A missing key is PERMISSION_DENIED and a held key at too low a tier is INSUFFICIENT_AUTHORITY| route, journey, database, unit| 6|
| `128`| permissions| A staff read outside the actor's primary hub is audited once, without contents| route| 1|
| `130`| permissions| Every operation refuses in one order| route, database, unit| 5|
| `131`| permissions| Statuses follow one rule| route, unit| 3|
| `132`| permissions| The reason catalogue is readable for the operations and branches that take a reason, and by no one else| route, database, unit| 5|

## 3. What is not claimed, and what is owed

**The walk of rows 1, 2 and 12 is reported complete, and is the only part of S0.70 that is done.** S0.70 and Gate 8 stay open while the items below are open, and passing the gate is the owner's decision.

Not passed, not claimed, and listed here as such (the plan's [§1.2](SLICE-000-IMPLEMENTATION-PLAN.md#12-current-position) and [§7](SLICE-000-IMPLEMENTATION-PLAN.md#7-deferred-obligations--what-is-owed-and-not-yet-run) hold the detail):

- **The full gate has not been passed on this tree.** The Stage 7 gate failed only on machine load, and the owner starts the gate (`pnpm run gate`); every Stage 8 task was tested with `test:affected` and the precheck. **The last combined run did not end green:** after a power cut it was finished in parts, and its database group had three process-start timeouts under load (each file passes alone): [the plan's §7.49](SLICE-000-IMPLEMENTATION-PLAN.md#749-stage-8-s062-to-s070-27-and-28-october-2026). Run the gate on a quiet machine.
- **Linux, WSL2 and CI evidence** (OB-25 and OB-26; OB-24, the Linux runs of the tests Windows skips, was obtained in the hosted run of 11 October 2026): the verifier's build and the HTTPS journeys of the three engines run in CI only. The integrated journeys ran in Chromium over plain HTTP.
- **S0.28**, the accessibility baseline, is the owner's. **S0.61**, the real handset: the rider journeys use the substitute attestation, which stands for an accepted chain.
- **Release gates G1 to G5** and the Staging walk. The measured values of S0.65 are proposals for the owner's approval ([the capacity report](SLICE-000-CAPACITY-REPORT.md)); external authentication exposure waits for them (G2).
- **Three findings await the owner** ([the plan's §7.49](SLICE-000-IMPLEMENTATION-PLAN.md#749-stage-8-s062-to-s070-27-and-28-october-2026)): which refusals the contract lists (`VALIDATION_FAILED` on eight operations), the severity of an expired lease, and the verifier serving its counters from zero.
- **The evidence state of each criterion** is owed (section 2), and **the date field** (React Aria Components, wired after the walk) has not been walked and awaits the owner's acceptance of its look.
- **Rows 7 to 11, 13 and 15 of the demonstration** ran in the integrated journeys, with the Rider's and the Vendor's halves at API level; the Rider and Vendor clients are built by later slices.
