# Global record lookup

> **Status:** ACTIVE SPECIFICATION — implementation status is stated in section 16
> **Owns:** finding a record from anywhere in the Ops Portal by its code, a name or a phone number typed in full
> **Slice:** none: a contract task of the Ops Portal redesign (task C2, Product Owner, 5 November 2026), delivered between `SLICE-001` and the shell step R4

## 1. Purpose and scope

The top bar's search and the Ctrl/Cmd K palette of the Ops Portal ([the Ops surface, section 4](../../surfaces/ops-portal.md#4-navigation-model)) open any record the person may open, by **its code, a name, or a phone number typed in full**. This feature owns the one read that serves them, `lookupRecords`, and the client hook that asks it. It is a way to **find** a record: opening it is the record's own read, with its own key and scope.

**In scope:** the five kinds of record that have a built page in the Ops Portal: pickup requests, pickup runs (manifests), vendor accounts, riders and staff profiles; the three ways of asking; the scope of what is returned; the shape and the masking of the answer; the hook `useRecordLookup`.

**Out of scope:** the palette and the top bar (step R4); a kind with no built page (orders, intakes, deliveries, payments); a search by email, by address or by what a record says; matching that forgives a typing error; a page after the first (a lookup returns at most 20 results and says no more); a search that writes anything.

## 2. Governing requirements

- [Master specification](../../PROJECT_MASTER_SPECIFICATION.md) section 17.4: **search never leaks another vendor's or an unauthorised hub's data**, because search crosses record boundaries by design.
- [The Ops surface](../../surfaces/ops-portal.md), section 4 (the top bar and the palette) and section 10; [the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md), task C2.
- [permissions.md](../../contracts/permissions.md): no key is added; a kind is searched under the key of that kind's own read.
- [data-scope-registry.md](../../contracts/data-scope-registry.md) section 7.3: the read is scoped by the rows of the registry and by nothing else.
- [audit.md](../../contracts/audit.md) section 5.4: a staff read of a record outside the actor's own hub writes `auth.hub_boundary.crossed`.

## 3. Actors and surfaces

Any signed-in **Ops Portal staff session** (Ops Staff, Senior Ops, Platform Admin, Finance and any other staff bundle). A Vendor session is refused by the surface gate (`PERMISSION_DENIED`), as it is for every Ops operation; **a Rider's bearer credential, which this browser-only operation does not take, is `SESSION_INVALID`**, the answer of a request with no usable session, as [the hub filters](hub-filters.md#3-actors-and-surfaces) word it for the reads that are the Ops Portal's alone. The only surface is the Ops Portal.

## 4. Preconditions

A staff session. The kinds searched are those whose read key the session's bundle holds; a session that holds none of the four keys gets an empty list.

## 5. Behavior

**The query** is one string, the field `q` of the JSON body of the request, of **2 to 64 characters as sent**: the contract refuses anything else (no body, no `q`, a `q` that is not a string, any other field) before the server reads it. The server then trims it and makes each run of white space one space, and refuses a text of fewer than 2 characters after that and a text with a NUL character (which no name holds, and the database refuses). Each refusal is `VALIDATION_FAILED`, naming the field `q` (or the body itself, where there is none or it carries a field it should not: the platform spells the body with an empty pointer). The Ops Portal sends the text already trimmed and folded.

**The text travels in the body of a POST and never in the address** (the Product Owner's decision of 6 November 2026, on the report of task C2): a phone number typed in full must not be in a URL, which proxies, monitoring tools and logs may keep ([the observability design, section 2.3](../../architecture/OBSERVABILITY_AND_RECOVERY.md#23-what-is-never-measured-into-a-log): a reverse proxy logging a query string and an APM span carrying request attributes are outside whatever the application's own redaction was taught). The call changes nothing and is a POST for that reason alone, so it follows the API's conventions for a POST that changes nothing: it is protected as every staff POST is (the session's cookie, the synchronizer token and the `Origin` of the Ops Portal; `CSRF_VALIDATION_FAILED` otherwise), its answer is `Cache-Control: no-store`, and it takes **no `Idempotency-Key`**, because no convention asks one of a read and repeating the call repeats a read and nothing else. Its limits are those of a read: the lengths above and the 8 and 20 results below. There is no read by address: a `GET` of the path is not a route.

The server decides what the query is, in this order, and **asks only the question that kind of query means**:

1. **A code.** Text of the shape of an operational code (`HUB-TT-XXXXXX`: three letters, two letters, six letters or digits; case does not matter) returns **at most the record that carries that code**: a pickup request (`PR`) or a pickup run (`MF`). No other question is asked of any kind. A code that matches no record, or none the session may open, is an empty answer: never `403` or `404`, which would tell a person that a code exists.
2. **A phone number typed in full.** Text that is a whole phone number, normalised exactly as `findAdHocSender` normalises one (`+233241234567`, `0241234567`, `233241234567` and `024 123 4567` are one number), returns the **pickup requests whose own contact phone (primary or secondary) is that number** and the **riders whose phone is that number**. A partial or invalid number matches no phone and is read as a name. The phone of an ad-hoc sender is never searched: an ad-hoc sender is global to staff, and a number resolved through it would tell a person which hub a sender is booked in.
3. **A name.** Anything else is a **case-insensitive word-prefix** search: the text matches a name when the name, or any word of it (words are separated by spaces), begins with it. `%` and `_` are what they are in a name, not patterns. The names searched: a pickup request's sender name, a vendor's legal and trading names, a rider's name, a staff member's name. **A pickup request is searched by name only while it is current work** (the Product Owner's decision D3, option (c), 6 November 2026), and the exact rule is this: **its `state` is not a terminal state (`DECLINED` and `CANCELLED` are the terminal states of a request, [state-machines.md](../../contracts/state-machines.md#3-pickuprequest), section 3) or its `scheduled_service_date` is on or after the hub's today minus 30 days** (a date of today or later is in). *Today* is the hub's clock, the database's instant read on `Africa/Accra` (`hubToday`), one clock for every hub. A declined or cancelled request whose service date is more than 30 days past is **not returned by a name**, and is returned by its code and by its phone number typed in full, which no window bounds. The other kinds have no window. The 30 days is a constant of the code (`NAME_SEARCH_WINDOW_DAYS`) and not a setting ([section 9](#9-settings)).
4. **A vendor's code** is its account identifier (eight characters, the sign-in identifier). When the text has its shape it is matched exactly **in addition to** the name, because an eight-letter name can have the same shape.

**What is returned for a kind is what the person could open.** Each kind is searched **in the transaction and under the key of that kind's own read** (`pickup.read` for requests and runs, `vendor.read`, `dispatch.read`, `staff.read`), so the scope is the scope of that grant (the hubs of the grant, or every hub where the grant is of all) enforced by the same row-level security; a record of another hub, or of a hub the grant does not reach, is not returned. A kind whose key the session does not hold is **absent from the answer**, which tells nothing about whether such records exist.

**The answer** is a list of at most **8 results per kind and 20 in all**. The kinds come in a fixed order (pickup requests, pickup runs, vendor accounts, riders, staff profiles); within a kind a pickup request comes newest first, the others by name, then id; the 20 are taken in that order, so a kind later in the order can be left out of a crowded answer, and an earlier kind is never. Each result has its **kind, id, code (when the record has one), title and the facts that say where the record stands: its own state, its hub (id and display name) and, for a pickup request and a pickup run, its service date**, and, **for a pickup request only, the sender's name exactly as the request's own read shows it (`sender_name`; the Product Owner's decision of 6 November 2026)**, so that a request found by a name shows whose it is and nothing else of it. The id of a vendor result is the account's, which is what its page is addressed by. **A result names no page and carries no wording** (the Product Owner's decision of 6 November 2026): the Ops Portal maps a kind and an id to its own route and writes its own line from the facts, so the words on the screen have one owner ([the Ops surface](../../surfaces/ops-portal.md#4-navigation-model)). **A phone number appears in a result only when the person searched by it, and then only masked** (`phone_hint`), as the platform masks a number it shows (`+233******567`: the country part and the last three digits). No clear phone, email, credential or address is ever in a result, beyond what the sender's name says as the request's own read shows it (a label a person typed, and no more exposed here than there).

**It is a read and only a read.** It writes nothing but the audit event of a hub crossing: **once for each hub other than the actor's own that the returned results represent** (the actor's own hub is its primary hub; a staff member with none, such as a Platform Admin without a hub, crosses every hub), as the lists write it; an answer with no result writes none. **The events are written together, in one step of their own, after every search has succeeded** (the audit of 7 November 2026, A4): each key is searched in a transaction of its own and writes nothing, the hubs the results represent are collected, and only a lookup that is going to answer writes its events, in one transaction, before it answers; a search that fails after another has found a hub writes none, and a ledger that cannot take them fails the read. It is `qualifying` activity (a typed search is the person's own act), `Cache-Control: no-store`, and the same query asked twice reads twice.

**It is counted and it is bounded.** Every request of a session is counted in the session's one bucket of authenticated API requests (`rate_limit_authenticated_api`; the limit is that setting's, in [settings.md](../../contracts/settings.md) section 7.7, and is not restated here), by the authentication step before the CSRF check and before the operation runs, as it counts every operation the session may ask; the request past the limit is `RATE_LIMITED` (`429`), reads nothing and writes no event. The typed search asks as the person pauses, and each of its requests counts. And **every statement of a lookup is bounded at 3 seconds** (a `SET LOCAL statement_timeout` at the start of each key's transaction, which only ever lowers the bound the configuration set; `RECORD_LOOKUP_STATEMENT_TIMEOUT_MS`, the Product Owner's decision of 7 November 2026 on the audit, A5, as the summary's counts are bounded by `AC-QSUM-13`): a search that cannot finish in that time, the name search of [section 14](#14-unresolved-requirements) being the one that can, ends the whole read as the platform's failed read (`503`, no code), returns nothing of what the other keys found and writes no event, and the next lookup meets no leftover setting.

## 6. Entities

[domain-model.md](../../contracts/domain-model.md): `PickupRequest` (section 6.2), `PickupManifest` (6.3), `VendorAccount` and `VendorOrganization` (6.8), `RiderIdentity`, `StaffIdentity`. Nothing is added.

## 7. States

None of its own. A result carries the state of its record as the **value of the record's own enumeration, unchanged and not reworded**: the `state` of a pickup request or a pickup run, the `status` of a vendor account, a rider or a staff profile ([state-machines.md](../../contracts/state-machines.md); the enumeration a value belongs to follows the result's kind). A cancelled or declined request is found by its code and by its phone number like any other, and by a name while it is within the window of [section 5](#5-behavior).

## 8. Permissions and scope

No permission admits the call: it is a `self` operation, and **each kind is admitted by the key of its own read**. [permissions.md](../../contracts/permissions.md) section 7; [data-scope-registry.md](../../contracts/data-scope-registry.md) section 7.3.

| Kind | Key | Scope (the grant of that key) | Searched by |
|---|---|---|---|
| `PICKUP_REQUEST` | `pickup.read` | the hubs of the grant | code, contact phone in full, sender name (current work only, [section 5](#5-behavior)) |
| `PICKUP_MANIFEST` | `pickup.read` | the hubs of the grant | code |
| `VENDOR_ACCOUNT` | `vendor.read` | the hubs of the grant (the organisation's responsible hub) | account identifier, legal or trading name |
| `RIDER` | `dispatch.read` | the hubs of the grant (the rider's primary hub) | phone in full, name |
| `STAFF_IDENTITY` | `staff.read` | the hubs of the grant (the member's primary hub) | name |

**Negative access:** a Vendor session is `PERMISSION_DENIED` (surface gate); a Rider's bearer credential, which this browser-only operation does not take, and no session are `SESSION_INVALID` (`negative-access-sweep.db.test.ts` holds the same for every operation); a record outside the hubs of the grant, a vendor's record the session's key does not reach, and a kind the bundle holds no key for are **never returned**, and nothing in the answer says they exist.

## 9. Settings

None of its own. How often a session may ask is the shared `rate_limit_authenticated_api` ([settings.md](../../contracts/settings.md) section 7.7). The 30 days of the window ([section 5](#5-behavior)) and the 3 seconds of the bound on a statement are constants of the code (`NAME_SEARCH_WINDOW_DAYS`, `RECORD_LOOKUP_STATEMENT_TIMEOUT_MS`) and not settings: [settings.md](../../contracts/settings.md) has none for them and none is invented here. A setting would be the Product Owner's decision.

## 10. Errors

[errors-and-enums.md](../../contracts/errors-and-enums.md): `VALIDATION_FAILED` (naming the field `q` for a `q` that is missing, is not a string, has fewer than 2 or more than 64 characters as sent, fewer than 2 once trimmed, or a NUL character, and the body itself where there is none or it has another field), `CSRF_VALIDATION_FAILED` (as every staff POST), `PERMISSION_DENIED` (surface), `SESSION_INVALID`, `RATE_LIMITED` (the session's bucket, [section 5](#5-behavior)). A search that outlasts its bound is the platform's failed read, `503` with no code ([section 5](#5-behavior)).

## 11. Audit and side effects

`auth.hub_boundary.crossed` ([audit.md](../../contracts/audit.md) section 5.4), enhanced, once for each foreign hub the returned results represent, naming the hub and the operation, written together after every search has succeeded ([section 5](#5-behavior)): a lookup that fails writes none. No notification, file or asynchronous effect.

## 12. API operations

`lookupRecords` (`POST /ops/lookup`, the body `{ "q": "…" }`; a POST that changes nothing, [section 5](#5-behavior)) in [openapi.yaml](../../contracts/openapi.yaml). Every identifier it returns is addressed by that record's own read (`getPickupRequest`, `getPickupManifest`, `getVendorAccount`, `getRider`, `getStaffIdentity`), which holds the authorized path to it.

## 13. Acceptance criteria

### `AC-LOOKUP-01` — The query is two to sixty-four characters as sent, and two once trimmed

```text
Given a staff session,
When it asks lookupRecords (a POST) with no body, a body with no q, a q that is not a string, a q that is empty, one character, spaces around one character, more than 64 characters as sent (spaces included), or a NUL character in it, or a body with a field besides q,
Then the answer is VALIDATION_FAILED naming the field q (or the body itself, where there is none or it carries a field it should not) and nothing is read,
And a query of 2 to 64 characters as sent whose trimmed text has 2 or more characters is searched on that trimmed text, a run of spaces inside it being one space,
And the text is read from the body alone: a q in the address with none in the body is VALIDATION_FAILED, and a GET of /ops/lookup is no route (nothing is read by address), so that a phone number typed in full never travels in a URL.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-LOOKUP-02` — A code finds at most the record that carries it

```text
Given a pickup request, a pickup run and a vendor account in the hubs of the session's grants,
When the session asks for the request's code, the run's code, either in lower case or with spaces around it,
Then the answer holds that record alone, whatever else in the data begins with or contains the text,
And a code that names no record, a record of another hub, and a code of a record type that has no page here are an empty answer with status 200,
And a session without pickup.read asking for a request's code gets an empty answer.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-03` — A phone number counts only when typed in full

```text
Given a pickup request whose contact phone is +233241112222 and a rider whose phone is +233241112222,
When the session asks for 024 111 2222, 0241112222, 233241112222 and +233 24 111 2222,
Then each finds the request and the rider (the kinds it may search) and nothing else,
And 024 111, 0241112 and a number with a letter in it find nothing by phone and are read as names,
And an ad-hoc sender's own phone is never matched, so that a number that is a sender's phone and no request's contact phone finds nothing.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-04` — A name matches at the start of any word, without regard to case

```text
Given a request whose sender is "Kofi Mensah-Demo", a vendor "Asante Fabrics Ltd" and a rider "Ama Boateng",
When the session asks for kofi, MENS, "kofi men", fabrics, "ama b" and "fab",
Then the request, the vendor, the rider are found by exactly the words that begin a word of their names ("kofi", "MENS" (the second word of "Kofi Mensah-Demo"), "kofi men", "fabrics", "ama b", "fab"),
And "ofi", "ensah" and "abrics" (the inside of a word) find nothing,
And a "%" or "_" in the query is a character of a name and matches no other,
And a pickup request is found by a name only within the window of AC-LOOKUP-13.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-05` — A kind is searched only if the session holds its key

```text
Given a bundle that holds pickup.read and staff.read and not vendor.read or dispatch.read, with a request, a vendor, a rider and a staff member named alike,
When the session asks for the name,
Then the answer holds the request and the staff member and neither the vendor nor the rider,
And a session that holds none of the four keys gets 200 with an empty list.
```

**Governs:** this feature, section 5; [permissions.md](../../contracts/permissions.md) · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-06` — A result is one the session could open

```text
Given records of a first hub and of a second hub of every kind, a vendor of each hub, and sessions of an Ops Staff officer and a Senior Ops user of the first hub and of a Platform Admin with no primary hub,
When each asks for a name, a code and a phone that match records of both hubs,
Then the officer and the Senior Ops user are given the records of the first hub alone and the Platform Admin those of both,
And every id returned opens, through its record's own read, for the session that was given it,
And no record the session's grant of that kind's key does not reach is returned, whatever the other grants of the bundle reach (a bundle of pickup.read at its hub and staff.read at all hubs gives the requests of its hub and the staff of every hub).
```

**Governs:** this feature, sections 5 and 8; [data-scope-registry.md](../../contracts/data-scope-registry.md) section 7.3 · **Surface:** Melarc Ops · **Test level:** API and integration · **Code:** none

### `AC-LOOKUP-07` — Only an Ops staff session may ask

```text
Given a Vendor session, a Rider's bearer credential and a request with no session,
When each asks lookupRecords,
Then the Vendor is PERMISSION_DENIED (the surface gate),
And the Rider's bearer credential, which this browser-only operation does not take, and the request with no session are SESSION_INVALID, the one answer of a request with no usable session, which tells nothing about the operation,
And nothing is read and no event is written for any of the three.
```

**Governs:** this feature, section 3 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`, `SESSION_INVALID`

### `AC-LOOKUP-08` — At most eight a kind, twenty in all, in a fixed order

```text
Given twelve requests, twelve vendors and twelve riders that a name matches,
When the session asks for the name,
Then the answer holds eight requests, eight vendors and four riders, in the order pickup requests, vendor accounts, riders,
And the requests are newest first and the others by name then id, and asking again gives the same answer in the same order,
And no staff member is returned when the twenty are taken, and none is read for.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-09` — A phone is shown only when searched by, and only masked

```text
Given a request and a rider with a phone,
When the session searches by a name, by the code, and by the phone,
Then no result of the first two carries a phone, a result of the third carries the number masked as its phone_hint, +233******567, and never in clear,
And no result of any search carries an email, a credential, an address or an unmasked number anywhere, except in the sender's name exactly as the request's own read shows it.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-10` — A result carries the record's facts, not a route and not wording

```text
Given a result of each kind,
When the session reads it,
Then it carries its kind, the id of the record (the account's for a vendor), the code where the record has one (a request's or a run's operational code, a vendor's account identifier) and a title,
And the record's own state as the value of its own enumeration, unchanged (the state of a request or a run, the status of a vendor account, a rider or a staff profile),
And the record's hub as its id and display name (the responsible hub of a request, a run and a vendor, the primary hub of a rider and a staff profile; none for a staff profile with no primary hub),
And, for a pickup request and a pickup run, the service date as a date (the request's scheduled service date, the run's service date), and for no other kind,
And, for a pickup request, the sender's name (sender_name) exactly as the request's own read shows it, found by a code, by a phone or by a name alike, and for no other kind,
And the answer carries no route, no subtitle, no sentence and no other field.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-11` — A lookup is the person's act, written down when it crosses a hub, and never cached

```text
Given a staff member whose primary hub is the first hub, and records of the first and second hubs,
When they ask for a name that matches records of both,
Then one auth.hub_boundary.crossed is written for the second hub and none for the first, naming the operation lookupRecords,
And a staff member with no primary hub is written one for each hub the results represent,
And an answer with no result writes no event, an event is written for no hub of a result that was cut from the twenty,
And the events are written together, after every search has succeeded: a lookup in which a search fails after another has found a record of the second hub is a failed read and writes no event for that hub or for any other, and the same lookup asked again, once it succeeds, writes them,
And the answer is Cache-Control: no-store and the call extends the idle lifetime of the session,
And the call, a POST, is refused 403 CSRF_VALIDATION_FAILED, reading nothing and writing no event, when it carries no synchronizer token, another session's token, or an Origin that is not the Ops Portal's,
And it takes no Idempotency-Key: a request without one is answered, and asking the same query twice reads twice.
```

**Governs:** this feature, sections 5 and 11; [audit.md](../../contracts/audit.md) section 5.4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `CSRF_VALIDATION_FAILED`

### `AC-LOOKUP-12` — The client asks late, asks little, and never shows an earlier query's answer

```text
Given the hook useRecordLookup in a signed-in Ops Portal,
When the text changes faster than 200 ms, has fewer than two characters once trimmed, or the session has ended,
Then no request is sent for it, and one request is sent for the text that stays still for 200 ms,
And while a later text waits or is being answered the earlier text's results are not offered as its own,
And a failed read is an error state with a way to try again, and an answer with no results is an empty state, never an error,
And the page that opens a result is the one the Ops Portal gives its kind and id (recordRoute), never anything the answer says, and an id that is not an identifier opens nothing,
And the text is sent in the body of a POST with the session's synchronizer token and no Idempotency-Key, and nothing of it is in the address.
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** Portal component tests · **Code:** none

### `AC-LOOKUP-13` — A name finds a pickup request only while it is current work; a code and a phone number find it always

```text
Given pickup requests with the same sender name that a name search matches, in one hub: a CONFIRMED one and a PENDING one with a service date 200 days past, a CANCELLED one with a service date 5 days past, a CANCELLED one and a DECLINED one with a service date exactly 30 days before the hub's today, a CANCELLED one and a DECLINED one with a service date 31 days before it, and a CANCELLED one with a service date 10 days after it,
And, in a second hub, a CANCELLED request with a service date 5 days past and one with a service date 31 days past, and a rider of the first hub whose name matches the same text,
When a session of the first hub, and a Platform Admin, ask for the name,
Then the session of the first hub is given the CONFIRMED and the PENDING request (a state that is not terminal, whatever the date), the CANCELLED one of 5 days past, the two of exactly 30 days past, the one 10 days ahead, and the rider (no other kind has a window), and neither of the two requests of 31 days past,
And the Platform Admin is given those and the recent request of the second hub, and not the one of 31 days past there,
And asking for the code of each of the two requests of 31 days past gives that request, and so does asking for its contact phone typed in full,
And a request outside the window is not returned by the name through any other way a name is typed (a first word, a second word, upper case).
```

**Governs:** this feature, section 5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none

### `AC-LOOKUP-14` — A lookup is counted in the session's bucket of API requests

```text
Given a staff session that has asked for as many lookups in a minute as the setting rate_limit_authenticated_api allows,
When it asks one more in that minute,
Then the answer is RATE_LIMITED (429, no Retry-After), nothing is read and no event is written,
And the lookups were counted in the session's one bucket, shared with every other operation the session asks (a lookup has no bucket of its own and no other limit),
And another session is not limited by it.
```

**Governs:** this feature, section 5; [settings.md](../../contracts/settings.md) section 7.7 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `RATE_LIMITED`

### `AC-LOOKUP-15` — A search is bounded at three seconds, and a search that is cut writes nothing

```text
Given a staff session that reaches two hubs, whose lookup finds records of both in the first keys it searches,
When a later search cannot finish within 3 seconds (the name search held on a lock for longer than that, for the test),
Then the whole read ends after about 3 seconds as the platform's failed read (503, no code, a body of the platform's own words and the request id alone),
And nothing of what the earlier keys found is returned and no auth.hub_boundary.crossed is written for either hub,
And the next lookup, which meets no leftover setting, answers whole and writes the events of the hubs its results represent.
```

**Governs:** this feature, section 5; `AC-QSUM-13` (the same bound on a count) · **Surface:** Melarc Ops · **Test level:** API and database tests (the bound itself, and a search held on a lock for longer than 3 seconds) · **Code:** none (the platform's `503`)

## 14. Unresolved requirements

- **The words of a result line and the page a result opens are the Ops Portal's, not the API's** (the Product Owner's decision D1, 6 November 2026): the answer carries facts (the state as the record's own value, the hub, the service date, a masked phone) and the palette of step R4 writes the line in the Portal's presentation words and maps a kind and an id to its own route.
- **A pickup request found by a code, a number or a name carries its sender's name** (`sender_name`; the Product Owner's decision of 6 November 2026, on the report of task C2): the label the request's own read shows (the registered vendor's trading name, its legal name when it has none, or the ad-hoc sender's name), and nothing more of the request. Its title is still its code.
- **The name search is slow at scale, and the window the Product Owner chose (decision D3, option (c), 6 November 2026) cannot bound it as things stand, because a collected pickup request stays `CONFIRMED`.** *The cost* is the row-level security policy running first: `ILIKE` is not leakproof, so the planner may neither run it before the policy nor use an index on it below the policy, and the plan is a sequential scan that evaluates the policy for each row it reaches (about 3 microseconds a row, 1.1 to 1.5 s for 400,000 rows). A `pg_trgm` GIN index on `pickup_request.sender_name` (8.5 MB) was built and tried: the planner does not use it under the policy (the same plan and time), while without the policy it answers in 34 ms, so the extension and the index were **not added** (the Product Owner: no `pg_trgm`). Caching the policy's settings and its hub set inside the policy expression did not reduce the time, and a leakproof function cannot be created by a migration (no application login is a superuser). What is leakproof, and so can run before the policy: equality and the range comparisons of text and of dates, and `starts_with`; **not** `LIKE`, `ILIKE`, `lower`, `strpos` or a regular expression. *The window* ([section 5](#5-behavior)) searches a request by a name when its state is not terminal or its service date is on or after the hub's today minus 30 days. The only terminal states are `DECLINED` and `CANCELLED` ([state-machines.md](../../contracts/state-machines.md#3-pickuprequest), section 3), and a request that has been collected is not closed: its stop moves and the request stays `CONFIRMED` for ever. So the window takes out only the declined and cancelled requests older than 30 days. *Measured again* (6 November 2026) on a disposable database of 400,030 pickup requests in two hubs, PostgreSQL 18, the runtime login under the session's row-level security, the whole read through HTTP, 15 runs of each of six texts after a warm-up; each pair below is the p50 and the p90, as the range over the six texts:
  - **A. Data as the state machine produces it** (90% `CONFIRMED`, 8% `CANCELLED`, 2% `DECLINED`, service dates spread over two years): the window leaves 90% of the requests in scope, and the plan is the same sequential scan. A name search takes **1.22–1.64 s and 1.32–1.89 s for a session of one hub (Ops Staff), 1.23–1.30 s and 1.31–1.64 s (Senior Ops), and 0.66–0.75 s and 0.74–0.88 s for a Platform Admin**: the 150 ms of the Product Owner's target (p90) is missed by a factor of 9 to 13 for a session of one hub and 5 to 6 for a Platform Admin, as it was before the window. An ordinary btree on `scheduled_service_date` is not used (the window is not selective), so none was added.
  - **B. If a request that is finished were terminal**, which is what the decision assumed (a stand-in: every request older than 30 days `CANCELLED`, so that 4% of the requests are in scope): the existing index `pickup_request_hub_idx` (hub, state, service date) serves both branches of the window as a bitmap OR (a skip scan), the plan takes 58 to 64 ms, and the read takes **94–105 ms and 110–157 ms (Ops Staff), 102–118 ms and 118–172 ms (Senior Ops), and 75–89 ms and 90–128 ms (Platform Admin)**: at or just above the target for a session of one hub, below it for a Platform Admin. An extra btree on the date was tried: the planner used it for the date branch of the bitmap OR and the time did not improve (an officer's whole read: p50 94–101 ms and p90 106–131 ms with it, 94–105 ms and 110–157 ms without), so none was added.
  - **Ways forward** (the Product Owner decides; none is built; they are numbered, and the letters of the report on task C2 are not reused): 1. **Leave it until the volume needs it.** The cost is linear in the rows, so (extrapolated, not measured) a median of roughly 120 to 160 ms and a p90 of 130 to 190 ms at 40,000 requests, and a tenth of that at 4,000; production holds one hub. It stops answering, instead of slowing, when one scan reaches the bound of 3 seconds on a statement of a lookup ([section 5](#5-behavior), `AC-LOOKUP-15`; until 7 November 2026 it was the database's statement timeout, `DATABASE_STATEMENT_TIMEOUT_MS`, 5 s by default, which is above it and still ends a statement that the bound does not reach): the read then answers the generic failure, `503`. At the measured cost that is, extrapolated from the figures this item gave for 5 seconds (the cost is linear, and 3 seconds are three fifths of 5), at roughly 0.7 to 1 million requests in the table for a session of one hub (about 0.6 million at the slowest run seen) and 1.4 to 1.8 million for a Platform Admin. 2. **Say what "finished" is for a confirmed request** and have the database keep it (a marker on the request, set when all its stops are terminal, of the family of the marker the implementation plan already owes the manifest pool): the window then bites as in B, with no new index. 3. **Count a confirmed request as current work for 30 days too** (the condition becomes `state = 'PENDING' or date >= …`, one line of `currentWork`): B's speed, and a confirmed request older than 30 days, collected or stuck, is then found by its code or its phone only. 4. **Find out why the policy costs 3 microseconds a row** and fix it in the policy of every table, which would speed every read that cannot use an index; it is recorded as a performance task in [the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign), next to the marker for the manifest pool, and the name search is the case to measure it on. The derived table of lower-cased words with a btree that the report on task C2 offered is not built: the Product Owner ruled that nothing else is added while the target is missed; it stays possible.
- **Because the lookup is a POST, it runs on the platform's locked path, and a name search holds the session's bundle lock while it runs.** `OperationRunner.read` refuses any request of a method that is not safe, and the platform has no other door for a POST that changes nothing; so each key's transaction takes the shared policy lock of the session's bundle, judges the session's standing under it and runs the search inside it, at `READ COMMITTED` (there is no `REPEATABLE READ`: no key's transaction asks more than one source for a query). The lock is held until the transaction commits, so a name search holds it as long as it runs (about 1.3 s at 400,000 requests, A above). A reduction of that bundle takes the lock exclusively and waits for the holders, and the bundle's other requests that arrive meanwhile queue behind the waiting reduction and are refused with the generic failure if the lock is not theirs within `DATABASE_LOCK_TIMEOUT_MS` (2 s by default). Each key also costs two transactions (the coordinator's discovery and the locked one). At today's volumes none of it shows. **Since the audit of 7 November 2026 (A5) a statement holds the lock for 3 seconds at most** (the bound of [section 5](#5-behavior)), and the writing of the hub-crossing events is a transaction of its own that takes the lock for the time of its few inserts, after the searches have ended and released theirs. What would remove the cost is a door for a POST that changes nothing and takes no policy lock: a change to the authorization step ([the security design, section 13.10a](../../architecture/SECURITY_DESIGN.md#1310a-authorization-policy-coordination-revisions-and-the-lock-order)), which the Product Owner did not ask for and which is not made; **a lookup path that does not hold the bundle policy lock is a later performance task** (the Product Owner, 7 November 2026), recorded in [the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign).
- **The search by phone number is an equality on the request's two contact phones, which is leakproof and runs before the policy**: at 400,030 requests, with no index, the scan takes 0.1 s in the plan and the whole read a median of 85 to 150 ms (p90 up to 175 ms). A btree index on each of the two columns (migration `0076`; the second is partial, on the requests that have one) brings the plan to 0.2 ms. The whole read, on the locked path the POST takes (roughly 10 ms more than the lock-free read of task C2, which took about 20 ms for a session of one hub and about 40 ms for a Platform Admin: an estimate, from two runs on a shared workstation), takes a median of 33 ms (p90 53 ms) by a number and 27 ms (p90 32 ms) by a code for a session of one hub, and 53 ms (p90 73 ms) and 42 ms (p90 52 ms) for a Platform Admin, whose read also writes the hub-crossing events. The rider's phone, the codes and the vendor identifier are unique columns and are index probes. **The two indexes of migration `0076` are kept** (the Product Owner's decision of 6 November 2026).
- **Typing-error tolerance, searching by email or address, and fuzzy matching** are not specified and not built.
- **Masking** is the platform's existing rule for a number shown in a log or a hint ([OQ-049](../reporting/daily-operations-and-cash-report.md): the detailed masking design is still open); the lookup uses it unchanged.

## 15. Related documents

[The Ops surface](../../surfaces/ops-portal.md), [permissions.md](../../contracts/permissions.md), [data-scope-registry.md](../../contracts/data-scope-registry.md), [audit.md](../../contracts/audit.md), [the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md).

## 16. Implementation status

Task C2 (6 November 2026): specified here; contracted as `lookupRecords`; built in the API and as the hook `useRecordLookup`. The palette and the top bar that ask it are not this task's but step R4's: [the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign) says where that step stands.

Task C2.1 (6 November 2026, the Product Owner's decisions on the report of C2): the call became a POST that changes nothing, with the text in its body and never in a URL (`AC-LOOKUP-01`, `-11`); a pickup request's sender name joined its result (`AC-LOOKUP-10`); the name search of pickup requests was limited to current work (`AC-LOOKUP-13`, [section 5](#5-behavior) and [section 14](#14-unresolved-requirements)). Contract 5.93.0.

The audit of 7 November 2026 (A4, A5, A6; the API fixes of that audit): the hub-crossing events are written together, after every search has succeeded, so that a lookup that fails writes none (`AC-LOOKUP-11`); the request is counted in the session's bucket of API requests and answers `RATE_LIMITED` past it (`AC-LOOKUP-14`), which `lookupRecords` now declares; every statement of a lookup is bounded at 3 seconds (`AC-LOOKUP-15`); and a Rider's bearer credential is `SESSION_INVALID` and not `PERMISSION_DENIED` (`AC-LOOKUP-07`, section 8), as the negative-access sweep always held.
