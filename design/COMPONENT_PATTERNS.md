# Melarc Component Patterns

> **Status:** DRAFT IMPLEMENTATION BASELINE — document only patterns that exist or are immediately being implemented  
> **Version:** 1.1  
> **Date:** 5 October 2026; revised 6 October 2026 to reconcile it with the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md) (§4, §9, §12, §24, §33, §36, §40, §42)  
> **Repository path:** `design/COMPONENT_PATTERNS.md`  
> **Depends on:** `design/BRAND_FOUNDATION.md`, `design/DESIGN_SYSTEM.md`  
> **Owns:** implemented or immediately planned UI component patterns, their anatomy, variants, states, accessibility expectations, density behavior, and usage rules  
> **Does not own:** product workflows, business rules, API contracts, domain-state semantics, logo artwork, or speculative future component APIs

---

## 1. Purpose

This document records the reusable UI patterns that Melarc actually implements.

It is deliberately **small and implementation-linked**.

A component or pattern belongs here only when:

- it already exists in code; or
- it is immediately required by the current approved implementation work.

Do not use this file as a wishlist for every component Melarc may eventually need.

The initial scope is:

- Button;
- Link;
- Field / Label / Input / Help / Error;
- Alert;
- Loading Indicator;
- PageHeader;
- Application Frame;
- Error / Not Found presentation.

Future patterns such as dialogs, drawers, menus, data grids, toasts, date pickers, tabs, command palettes, charts, and complex navigation should be added only when real product requirements demand them.

---

## 2. Pattern lifecycle

Each pattern moves through these states:

```text
PROPOSED
    ↓
IMPLEMENTING
    ↓
ACTIVE
    ↓
DEPRECATED
```

### PROPOSED

Documented because implementation is about to begin.

### IMPLEMENTING

Code exists but the pattern is still being stabilized.

### ACTIVE

Approved for normal product use.

### DEPRECATED

Kept only while dependent screens migrate away.

Do not silently replace an active pattern with a new visual treatment.

---

## 3. Shared implementation rules

Every reusable component must:

1. consume semantic design tokens rather than scattered raw values;
2. expose accessible names and relationships;
3. support visible keyboard focus where applicable;
4. define disabled/loading/error states when relevant;
5. avoid color-only meaning;
6. use platform-appropriate semantics;
7. preserve server-authoritative business outcomes;
8. be tested for behavior, not only appearance;
9. document any important density or responsive behavior;
10. avoid product-specific business logic unless the component is explicitly a domain pattern.

---

## 4. Button

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 4.1 Purpose

Use Button for an action that changes application state, submits work, opens an interaction, or triggers a command.

Do not use Button for ordinary navigation when a Link is semantically correct.

### 4.2 Variants

The permitted variants:

```text
primary
secondary
tertiary
danger
```

This is the vocabulary, not a build list. The first implementation builds only the variants a current screen uses
(§30, §42), and each of the others is built to this pattern when a screen first needs it. Do not add variants beyond
these until a real product need exists.

### 4.3 Sizes

The permitted sizes:

```text
sm
md
lg
```

The first implementation builds `md` and adds another size with the first screen that needs it (§42).

Default:

```text
md
```

Recommended working heights:

| Size | Height |
|---|---:|
| `sm` | 32px |
| `md` | 40px |
| `lg` | 48px |

`sm` is intended for dense desktop contexts only.

### 4.4 Primary

Use for the main action of a surface.

Working semantics:

```text
background: color.action.primary
text: color.action.primaryText
hover: color.action.primaryHover
pressed: color.action.primaryPressed
focus: focus.ring
```

A page should rarely contain multiple equally prominent primary actions.

### 4.5 Secondary

Use for normal alternate actions.

Typical treatment:

```text
background: color.surface.default
text: color.text.primary
border: color.border.default
```

### 4.6 Tertiary

Use for lower-emphasis actions.

Typically:

- no filled background;
- text or subtle interactive treatment;
- still visibly interactive;
- full focus support.

### 4.7 Danger

Use only for destructive or high-risk actions.

Danger is a semantic variant, not an alias for Primary.

Danger actions must:

- use explicit wording;
- communicate consequence;
- not rely on red alone;
- use confirmation when the action is sufficiently destructive or irreversible.

### 4.8 States

Required states:

- default;
- hover;
- active/pressed;
- focus-visible;
- disabled;
- loading.

### 4.9 Loading

When Button initiates an in-progress action:

- prevent accidental duplicate submission when required;
- preserve button width where practical;
- show a loading indicator;
- keep an accessible name;
- do not show success until success is authoritative.

### 4.10 Accessibility

Button must:

- use native `<button>` semantics on web unless there is a strong reason otherwise;
- expose `type="button"` or `type="submit"` explicitly;
- have an accessible label;
- preserve focus visibility;
- not use disabled styling without disabled behavior.

### 4.11 Incorrect use

Do not:

- use Button for ordinary page navigation;
- use icon-only buttons without accessible names;
- place multiple Primary buttons side by side without hierarchy;
- use Danger styling for ordinary brand emphasis.

---

## 5. Link

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 5.1 Purpose

Use Link for navigation to another page, route, document, or external resource.

### 5.2 Variants

The permitted variants:

```text
default
subtle
inverse
```

The first implementation builds `default` (§42). `inverse` arrives with the authenticated Ops shell, which is the only
place a link sits on Ink, and `subtle` with its first use. Avoid building many stylistic link variants.

### 5.3 States

Required:

- default;
- hover;
- focus-visible;
- visited where appropriate;
- disabled only when semantically justified.

### 5.4 Rules

Links must:

- remain identifiable as navigation;
- have meaningful accessible text;
- not be styled as disabled buttons merely because navigation is temporarily unavailable;
- clearly indicate external behavior where useful.

### 5.5 Incorrect use

Do not:

- use `href="#"` for actions;
- use Link where a Button should perform a mutation;
- hide links using color alone with no other affordance.

---

## 6. Field pattern

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 6.1 Purpose

Field is the composition pattern that connects:

```text
Label
Control
Optional help text
Optional validation/error text
```

It should not become a generic form engine.

### 6.2 Anatomy

Recommended structure:

```text
Field
├── Label
├── Control
├── HelpText (optional)
└── FieldError (optional)
```

### 6.3 Label

Every user-input control needs a programmatically associated label unless its semantics are otherwise explicit and accessible.

Label rules:

- concise;
- specific;
- sentence case;
- no placeholder-as-label substitution;
- required state communicated programmatically.

### 6.4 Help text

Use for:

- format expectations;
- important context;
- non-obvious input consequences.

Do not use HelpText for errors.

### 6.5 Field error

FieldError should:

- state what is wrong;
- help the user correct it;
- be associated with the affected control;
- avoid vague messages such as "Invalid input" when a specific correction is known.

### 6.6 States

Field pattern must support:

- default;
- focus;
- filled;
- invalid;
- disabled;
- read-only.

---

## 7. Input

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 7.1 Purpose

Use Input for single-line textual or numeric entry where native input semantics apply.

### 7.2 Variants

Do not create aesthetic variants initially.

Input differences should come from:

- type;
- state;
- size;
- associated Field context.

### 7.3 Sizes

The permitted sizes (the first implementation builds `md`, §42):

```text
sm
md
lg
```

Default:

```text
md
```

### 7.4 Visual rules

Input should use:

```text
surface: color.surface.default
text: color.text.primary
border: color.border.control
radius: radius.md
focus: focus.ring
```

`color.border.subtle` is not sufficient as the sole control boundary.

### 7.5 Placeholder

Placeholder text:

- supplements a label;
- never replaces a label;
- should not contain critical instructions;
- should remain visually secondary.

### 7.6 Invalid state

Invalid Input should use:

- semantic danger treatment;
- FieldError text;
- programmatic invalid state.

Do not use red border alone.

### 7.7 Disabled versus read-only

Disabled:

- not interactive;
- visually subdued;
- excluded from submission where native semantics dictate.

Read-only:

- content remains legible;
- value may still be selectable/copyable;
- visually distinct from editable state.

Do not make read-only fields look disabled.

### 7.8 Numeric input

For money, counts, dimensions, or other domain values:

- preserve contract representation;
- do not format in a way that changes submitted value;
- keep server-side validation authoritative;
- avoid JavaScript floating-point assumptions where the contract uses integer minor units or strings.

---

## 8. Password Input

> **Status:** PROPOSED  
> **Initial implementation priority:** Only when identity UI is implemented

PasswordInput extends Input.

### 8.1 Additional behavior

May include a show/hide control.

The visibility control must:

- have an accessible name;
- communicate current state;
- not alter the underlying password value;
- remain keyboard accessible.

### 8.2 Security

Do not:

- log password contents;
- retain password values unnecessarily;
- prefill secrets from application state unless browser/platform conventions explicitly require it.

---

## 9. Alert

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 9.1 Purpose

Alert communicates important contextual information that should remain visible in the surface.

It is not the same as a transient toast.

### 9.2 Variants

The permitted semantic variants (they are one set of status meanings, with their recipes in DESIGN_SYSTEM §4.6; the
first implementation builds `danger` and `success`, §42):

```text
info
success
warning
danger
neutral
```

### 9.3 Anatomy

```text
Alert
├── optional icon
├── optional title
├── message
└── optional action
```

### 9.4 Rules

Alert must:

- use semantic status tokens;
- render approved presentation copy, chosen by the feature from the error's machine code, never the API's diagnostic
  `message` (§33);
- remain understandable without color;
- use appropriate live-region behavior only when dynamically inserted and urgent enough to justify it;
- keep actions secondary to the message.

### 9.5 Usage

Use for:

- important system notices;
- form-level errors;
- permission explanation;
- recoverable conflict guidance;
- warnings before high-risk workflows.

Do not use Alert as permanent decorative page chrome.

---

## 10. Loading Indicator

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 10.1 Purpose

Communicate that work is in progress.

### 10.2 Initial forms

Initial implementation may support:

```text
spinner
inline loading text
```

Skeletons may be added when a real page benefits from layout-preserving placeholders.

### 10.3 Rules

Loading indicators must:

- not imply completion;
- be accessible when they replace meaningful content;
- avoid unnecessary animation;
- respect reduced-motion preferences where applicable.

### 10.4 Button loading

Use compact spinner + retained label where possible.

Example:

```text
Saving…
```

rather than only an unlabeled spinner.

---

## 11. PageHeader

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 11.1 Purpose

PageHeader establishes page-level hierarchy.

### 11.2 Anatomy

```text
PageHeader
├── optional breadcrumb/context
├── title
├── optional description
└── optional actions
```

### 11.3 Rules

PageHeader composes the existing `PageHeading` (`apps/ops-web/src/components/PageHeading.tsx`), the page's one level-one
heading, which takes programmatic focus after a navigation. PageHeader adds the context, description and actions around
it and never replaces it.

PageHeader should:

- use one clear page title;
- avoid unnecessary visual decoration;
- allow actions without turning the header into a toolbar by default;
- collapse gracefully on narrow viewports.

### 11.4 Density

PageHeader belongs to the **spacious** density context.

Operational content below it may be compact.

---

## 12. Application Frame

> **Status:** the neutral frame exists (`apps/ops-web/src/app/AppFrame.tsx`) and is retained; the authenticated Ops shell is PROPOSED and DEFERRED to the identity slice  
> **Initial implementation priority:** the neutral frame is Required (it exists); the authenticated Ops shell is not part of the UI foundation gate

### 12.1 Purpose

Application Frame provides stable product structure without embedding business workflow logic.

There are three layouts, owned by route family, and they are not one component with optional parts. The families and
their rules are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §13.1 and are not repeated here. This section gives the anatomy
of each.

### 12.2 Anatomy

```text
NeutralFrame (exists as AppFrame)
├── SkipLink
├── Banner (the product name)
└── MainContent (the route's page; focus moves to its heading after a navigation)

AuthenticatedOpsShell (identity slice)
├── SkipLink
├── PrimaryNavigation (a plain list; none shown until the entries have a source)
├── TopContextArea (session identity, hub context)
└── MainContent
```

The setup layout is the neutral frame until the open decision in DESIGN_SYSTEM §13.1 is made. Exact navigation behavior
depends on the product surface.

### 12.3 Visual direction

Neutral frame: quiet, on `surface.page`, the product name in text, no Ink navigation. Pre-authentication pages carry no
Ink, no navigation and no signed-in affordance.

Authenticated Ops shell:

- Ink-oriented navigation structure;
- neutral working surface;
- restrained Crimson active accent, on a value that is visible against Ink (DESIGN_SYSTEM §4.6);
- spacious shell;
- efficient content area.

### 12.4 Rules

Every layout must:

- preserve landmark semantics, the skip link and the move of focus to the new page's heading after a navigation;
- be chosen by the route tree and never by the page it contains;
- remain responsive.

The neutral frame must never show, in any state (loading, challenge, error or success), navigation, a user menu,
sign-out, session data or anything loaded for a signed-in user. A `202` MFA challenge renders here, because it is not a
session. Tests assert this for each pre-authentication route as it is built.

The authenticated Ops shell must also:

- support keyboard navigation;
- expose current navigation state;
- avoid showing unauthorized actions as if they are available.

Navigation visibility does not replace backend authorization.

### 12.5 No fake operational content

The initial shell must not:

- invent KPI tiles;
- invent order counts;
- invent revenue;
- fabricate riders;
- present demo data as production state.

Development-only showcase data must be obviously non-production.

---

## 13. Error Page

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 13.1 Purpose

Provide recoverable presentation for page-level failure.

### 13.2 Anatomy

```text
ErrorState
├── concise heading
├── explanation
├── recovery action
└── optional reference/correlation ID
```

### 13.3 Copy

Prefer:

```text
We couldn't load this page.
Try again, or return to the previous page.
```

Avoid:

```text
Oops! Something went wrong.
```

### 13.4 Security

Do not expose:

- stack traces;
- database errors;
- internal service names;
- secret identifiers;
- raw exceptions.

---

## 14. Not Found

> **Status:** PROPOSED  
> **Initial implementation priority:** Required

### 14.1 Purpose

Present a clear 404-style state when a route/resource cannot be found.

### 14.2 Rules

Not Found should:

- explain that the requested page/resource is unavailable;
- offer a safe navigation action;
- avoid implying whether a protected resource exists if that would leak information.

### 14.3 Visual treatment

Use restrained neutral presentation.

Do not turn Not Found into a decorative marketing illustration unless there is a real product need.

---

## 15. Forbidden State

> **Status:** DEFERRED UNTIL AUTHORIZATION UI IS IMPLEMENTED

Add this pattern when a real workflow needs explicit forbidden presentation.

It should eventually distinguish:

- not authorized;
- approval required;
- role/permission missing;
- unavailable in current operational context.

Do not implement it prematurely as a generic screen.

---

## 16. Empty State

> **Status:** DEFERRED UNTIL FIRST REAL DATA SCREEN

Add only when a real list/table/dashboard needs it.

Required future anatomy:

```text
EmptyState
├── heading
├── explanation
└── optional useful action
```

Do not populate empty states with fake production-looking examples.

---

## 17. Skeleton

> **Status:** DEFERRED UNTIL NEEDED

Use only when:

- layout is predictable;
- skeleton reduces disruptive layout shift;
- loading duration justifies the complexity.

Do not use skeletons everywhere by default.

---

## 18. Status Badge

> **Status:** DEFERRED UNTIL DOMAIN STATUS MAPPING IS IMPLEMENTED

When introduced, StatusBadge must consume semantic status mappings rather than raw domain values.

Pattern:

```text
domain enum
    ↓
presentation mapping
    ↓
status semantic token
    ↓
StatusBadge
```

Do not hard-code:

```text
DELIVERED = green
FAILED = red
```

inside a generic Badge component.

The mapping belongs in the relevant domain/presentation layer.

---

## 19. Table Shell

> **Status:** DEFERRED UNTIL FIRST OPERATIONAL DATA SCREEN

The initial table pattern should be introduced from a real Ops workflow.

It must eventually define:

- column header behavior;
- row density;
- sorting;
- filtering;
- empty/loading/error states;
- actions;
- horizontal overflow;
- keyboard behavior;
- responsive strategy.

Do not implement a generic enterprise data-grid framework during the UI-foundation gate.

---

## 20. Dialog / AlertDialog

> **Status:** DEFERRED UNTIL FIRST REAL MODAL INTERACTION

Dialog should be introduced only when a real product flow needs modal interaction.

AlertDialog is for high-risk confirmation and must not be used for ordinary information.

Future implementation must define:

- focus trap;
- initial focus;
- return focus;
- escape behavior;
- backdrop interaction;
- destructive-action wording;
- responsive behavior.

Do not implement these during the initial foundation unless the current feature explicitly requires them.

---

## 21. Toast

> **Status:** DEFERRED

Do not introduce a toast system before a real workflow establishes:

- what messages are transient;
- which messages must remain persistent;
- whether actions/retries belong in a toast;
- accessibility/live-region behavior.

Important business outcomes must not exist only in disappearing toast messages.

---

## 22. Icon Button

> **Status:** DEFERRED UNTIL NEEDED

When introduced:

- icon-only controls require accessible names;
- tooltip may improve discoverability but does not replace the accessible label;
- target size must remain usable;
- icon meaning must be conventional or otherwise clear.

---

## 23. Component composition rules

Prefer composition over large option-heavy component APIs.

Good:

```text
Field
  Label
  Input
  FieldError
```

Avoid early abstractions such as:

```text
UniversalField
  type="all-things"
  mode="every-use-case"
  35 optional props
```

Components should remain understandable and testable.

---

## 24. Domain logic boundary

Generic UI primitives must not decide business policy.

For example, a generic Button must not know:

- whether a delivery can transition;
- whether a rider may receive cash;
- whether a vendor is suspended;
- whether a permission is sufficient.

That logic belongs in domain/application behavior and presentation adapters.

UI components render the resulting state.

Permissions and navigation entries are never inferred from a role name. Where the signed-in navigation entries come
from is an open contract question (DESIGN_SYSTEM §22).

### 24.1 Formatting and identity

Display formatting is separate from the value that is submitted or compared. Each rule has an owner; this table links to
the owner and does not restate it.

| Value | Owner of the rule | In the UI |
|---|---|---|
| Money | A minor-unit integer with a currency code, `GHS` only in Version 1, never a float or a decimal string ([domain-model](../contracts/domain-model.md) §3.2). A surface displays the server's amount and computes none ([surfaces/overview.md](../surfaces/overview.md) §5) | Show Ghana cedi from the integer (`2550` is GH₵25.50). A field turns what was typed into the integer without floating-point arithmetic, and formatting never changes what is submitted (§7.8) |
| Time | Stored as UTC instants; business time is `Africa/Accra`; a service date is a date, not an instant ([domain-model](../contracts/domain-model.md) §3.3) | Show 24-hour local time with no timezone label, for example `18 Aug, 14:30`. An export, or anything read outside Ghana, carries an explicit offset |
| Absent, zero and not yet loaded | A count never renders as `0` while it is still loading ([ops-portal](../surfaces/ops-portal.md) §8) | Show the loading state until a value arrives. Show `0` only for a returned zero. An absent value shows the field's own empty copy, never `0` |
| Operational codes | `HUB-TT-XXXXXX` from a confusion-free alphabet, read aloud on calls; the UUID is never shown ([domain-model](../contracts/domain-model.md) §3.1) | Never truncate, re-case or re-punctuate a code. Show all of it wherever a person must quote it, and make copying give exactly the characters shown |
| Credentials | The rule is shown and the value never is ([surfaces/overview.md](../surfaces/overview.md) §5) | No field can display a credential, masked or not |

---

## 25. Server authority

UI components must not create false authority.

Examples:

- disabled Button may improve usability, but backend permission remains authoritative;
- client validation may improve feedback, but backend validation remains authoritative;
- hidden navigation may reduce clutter, but backend authorization remains authoritative;
- optimistic UI must not fake irreversible success.

---

## 26. Accessibility testing expectations

Initial reusable components should be tested for:

- keyboard focus;
- accessible name;
- correct native semantics;
- disabled behavior;
- error association;
- status/alert semantics where applicable.

Do not rely only on visual snapshots.

---

## 27. Development showcase

A development-only component showcase is allowed during the UI-foundation gate.

Purpose:

- visually inspect tokens;
- inspect component states;
- verify density;
- compare responsive behavior;
- verify focus and contrast.

Rules:

- do not expose it as a normal production route unless explicitly intended;
- label all demonstration content as development/demo;
- never use realistic production-looking customer data;
- do not let the showcase become a second component specification.

---

## 28. Component file organization

Exact paths depend on the implemented web app, but an initial structure may resemble:

```text
apps/ops-web/src/
├── components/
│   └── ui/
│       ├── button/
│       ├── field/
│       ├── input/
│       ├── alert/
│       └── loading/
├── layout/
│   ├── application-frame/
│   └── page-header/
└── styles/
    └── tokens/
```

Do not create empty directories for deferred components.

---

## 29. Naming rules

Prefer clear names:

```text
Button
Input
Field
FieldLabel
FieldHelp
FieldError
Alert
LoadingIndicator
PageHeader
ApplicationFrame
ErrorState
NotFoundState
```

Avoid branded names such as:

```text
MelarcButton
MelarcInput
```

inside the Melarc application codebase unless there is a genuine namespace collision.

The design system makes them Melarc components; the component name should describe function.

---

## 30. Variant rules

Add a component variant only if:

- the semantic distinction is real;
- at least one current product use requires it;
- it cannot be expressed cleanly through composition;
- accessibility behavior remains clear.

Do not add variants simply because they look different in a mockup.

---

## 31. Responsive behavior

Reusable components must not assume one viewport.

At minimum:

- buttons may expand/full-width in narrow layouts where appropriate;
- Field/Input remain usable at mobile widths;
- PageHeader actions wrap/reflow;
- Application Frame changes navigation treatment when necessary;
- error/not-found states remain readable without fixed desktop widths.

---

## 32. Density behavior

Components may support density where the task requires it.

Do not expose a global `compact=true` prop on every component by default.

Prefer density at layout/container level, with components consuming the surrounding context only when a real need exists.

---

## 33. Copy rules and interface states

Reusable components should not embed product-specific messages. They render approved presentation copy that the feature
or presentation layer supplies.

Good:

```text
<Alert>{copy}</Alert>
```

where `copy` is wording the feature chose for the error's machine code.

Bad:

```text
<Alert>{apiError.message}</Alert>
<Alert type="deliveryFailed" />
```

The first renders the API's diagnostic `message`, the second puts product wording inside a generic primitive (unless
the component is explicitly a domain pattern).

A `message` in an API error is a diagnostic for engineers: it can carry identifiers, credentials or internal detail, so
it is never rendered. The feature maps the error's machine code
([contracts/errors-and-enums.md](../contracts/errors-and-enums.md)) to approved copy, and a code with no mapping gets
the generic copy of the error pattern (§13). Customer-facing wording is a Product Owner input; until it is supplied,
the generic copy is used and no wording is invented here.

Copy belongs with the feature or presentation layer. A message about permission or approval names the permission or the
deciding capability, never a role ([surfaces/ops-portal.md](../surfaces/ops-portal.md) §7, §8).

### 33.1 The nine interface states

The nine states are required by [surfaces/ops-portal.md](../surfaces/ops-portal.md) §8, which owns each requirement.
This table only says where each is presented.

| State | Presented by | Note |
|---|---|---|
| `loading` | LoadingIndicator (§10); Skeleton when it exists (§17) | a count is never `0` while loading |
| `empty` | EmptyState (§16, deferred) | a success message, not an error; says whether nothing exists or the filter hides it |
| `validation error` | FieldError (§6.5), and an Alert (§9) for a form-level summary | field-level, with recovery guidance |
| `error` | ErrorState (§13) or an Alert, with copy mapped from the machine code | never the diagnostic `message` |
| `retry` | a Button beside the error, separate from it | see §33.2 |
| `offline` | **not applicable** | the Ops Portal has no offline mode: lost connectivity is an `error`. Do not build an offline queue or a deferred-write interface |
| `stale / conflict` | an Alert (§9), written by the feature | `STATE_CONFLICT` explains what changed; the feature adapter owns it, not Button or Alert |
| `success` | an Alert, or the changed state of the page | confirms the state reached, not only that a request returned |
| `permission-restricted` | ForbiddenState (§15, deferred) or an Alert | a clear refusal that names the permission; hiding a control is not enforcement |

### 33.2 Retry, rejection and unknown outcomes

A **rejected** request got an answer, so nothing is in doubt and the copy follows the machine code. An **unknown
outcome** is a timeout, a dropped connection or a failure after the request was sent: the server may or may not have
acted.

- Never retry a mutation automatically, and never present an unknown outcome as a success or as a failure.
- For an unknown outcome the copy says that the result is not known and how to find out (reload the record). It offers
  a retry only where the operation is idempotent under the contract: the retry reuses the same `Idempotency-Key` and the
  same payload, and a replay returns the original result. Where the operation takes no such key, offer to reload the
  record instead.
- A failed read may be retried freely, because it changes nothing.
- Idempotency keys, version checks and conflict handling live in the feature adapter. Button, Alert and the other
  primitives know nothing of them (§24).

---

## 34. Internationalization readiness

Melarc Version 1 may use English only, but components should avoid assumptions that make future localization unnecessarily difficult.

Avoid:

- fixed-width text containers;
- concatenating sentence fragments;
- hard-coded grammar inside generic primitives.

Do not introduce a full i18n system unless product requirements require it.

---

## 35. Test identifiers

Do not expose test-only selectors as component API unless needed.

Prefer semantic queries in UI tests:

- role;
- label;
- text;
- accessible name.

Use dedicated test IDs only when semantic querying is genuinely impractical.

---

## 36. Initial implementation checklist

Before accepting the initial UI-foundation implementation:

### Button
- [ ] primary/secondary/tertiary/danger variants exist only if needed;
- [ ] keyboard focus visible;
- [ ] loading state accessible;
- [ ] disabled behavior correct.

### Link
- [ ] navigation semantics preserved;
- [ ] focus visible;
- [ ] link remains distinguishable.

### Field/Input
- [ ] label association works;
- [ ] help text association works;
- [ ] error association works;
- [ ] invalid state not color-only;
- [ ] read-only differs from disabled.

### Alert
- [ ] semantic status tokens used;
- [ ] text explains meaning;
- [ ] dynamic announcement behavior appropriate.

### Loading
- [ ] accessible label/state;
- [ ] reduced motion considered;
- [ ] no false-success behavior.

### PageHeader
- [ ] title hierarchy correct;
- [ ] actions reflow on narrow layouts.

### Neutral frame
- [ ] landmarks, skip link and focus after a navigation preserved;
- [ ] no navigation, user menu, sign-out or session data in any state, including the loading, challenge and error
  states of a pre-authentication route;
- [ ] no fake operational content.

### Authenticated Ops shell (identity slice)
- [ ] landmarks correct;
- [ ] navigation focus works;
- [ ] current location clear;
- [ ] no navigation entry inferred from a role name.

### Error / Not Found
- [ ] calm precise copy;
- [ ] safe recovery action;
- [ ] no internal error leakage;
- [ ] the API's diagnostic `message` is never rendered.

---

## 37. Deferred pattern register

This is not a backlog commitment.

It simply records patterns intentionally **not** built during the initial foundation:

| Pattern | Introduce when |
|---|---|
| EmptyState | first real empty data workflow |
| StatusBadge | first real domain status UI |
| Table shell | first operational data table |
| Dialog | first modal workflow |
| AlertDialog | first destructive confirmation |
| Toast | first justified transient feedback flow |
| IconButton | first icon-only action |
| Skeleton | first layout where it materially helps |
| Tabs | first real tabbed workflow |
| DropdownMenu | first real menu requirement |
| Drawer | first real side-panel workflow |
| Date/Time control | first date/time entry requirement |
| DataGrid | only if table requirements exceed a simpler table pattern |

---

## 38. Relationship to future product patterns

As Melarc product screens emerge, this file may gain domain-aware presentation patterns such as:

```text
ParcelStatus
PickupStatus
DeliveryStatus
PaymentStatus
HubContext
RiderAssignment
PermissionSensitiveAction
CustodyConfirmation
```

These should not be added until their domain behavior is implemented and understood.

---

## 39. Change discipline

When a component changes:

- visual-token changes belong in `DESIGN_SYSTEM.md`;
- brand-identity changes belong in `BRAND_FOUNDATION.md`;
- component behavior/pattern changes belong here;
- business-rule changes belong in the owning product specification.

Do not use this file to override a product contract.

---

## 40. Current pattern summary

| Pattern | Status | Initial foundation |
|---|---|---|
| Button | PROPOSED | Yes |
| Link | PROPOSED | Yes |
| Field | PROPOSED | Yes |
| Input | PROPOSED | Yes |
| PasswordInput | PROPOSED | Identity implementation |
| Alert | PROPOSED | Yes |
| LoadingIndicator | PROPOSED | Yes |
| PageHeader | PROPOSED | Yes |
| NeutralFrame (`AppFrame`) | EXISTS, retained | Yes |
| AuthenticatedOpsShell | PROPOSED | Identity slice |
| ErrorState | PROPOSED, existing code to adapt | Yes |
| NotFoundState | PROPOSED, existing code to adapt | Yes |
| ForbiddenState | Deferred | No |
| EmptyState | Deferred | No |
| Skeleton | Deferred | No |
| StatusBadge | Deferred | No |
| Table shell | Deferred | No |
| Dialog | Deferred | No |
| AlertDialog | Deferred | No |
| Toast | Deferred | No |
| IconButton | Deferred | No |

---

## 41. Next implementation step

After Product Owner review of:

- `design/BRAND_FOUNDATION.md`;
- `design/DESIGN_SYSTEM.md`;
- `design/COMPONENT_PATTERNS.md`;

the next design task is the **small UI Foundation implementation gate**.

That gate should:

1. encode approved tokens;
2. implement only the initial required patterns;
3. create a development-only visual showcase;
4. validate accessibility and responsive behavior;
5. avoid real product-feature implementation except where needed to prove the shell/foundation.

Do not build the full component catalogue upfront.

---

## 42. Existing code and the first implementation

The Ops application already has structural components. They are not the branded system yet, but they hold behaviour
that the system keeps: the landmarks, the skip link, focus after a navigation, the generic error message. A pattern
here with a similar name is not a reason to write a second component.

### 42.1 Inventory

Paths are under `apps/ops-web/src/`.

| Pattern here | Current code | Decision | Acceptance: tests that keep passing |
|---|---|---|---|
| NeutralFrame | `app/AppFrame.tsx` (skip link, banner, main, focus after a navigation, no navigation) | **Retain** the structure; move its styling onto tokens | `app/App.test.tsx` (landmarks, no navigation or session data, skip link first, focus after a navigation); `test/browser/shell.spec.ts` |
| Skip link | `components/SkipLink.tsx` | **Retain**, restyle | `app/App.test.tsx` (keyboard and focus) |
| PageHeading, the `h1` that takes focus | `components/PageHeading.tsx` | **Retain**; PageHeader (§11) composes it | `app/App.test.tsx` (one level-one heading, focus after a navigation) |
| PageHeader | none | **New**, on top of PageHeading | new: title hierarchy, reflow |
| Navigation for the authenticated shell | `components/PrimaryNavigation.tsx` (a plain list; renders nothing when empty; not used by the neutral frame) | **Retain** for the shell | `components/PrimaryNavigation.test.tsx` |
| ErrorState | `components/ErrorFallback.tsx`, `components/AppErrorBoundary.tsx`, `app/pages/RouteErrorPage.tsx` (`RouteErrorPage`, `FrameErrorPage`) | **Adapt**: tokens and Button; keep the generic copy, `role="alert"`, the explicit retry and the focus parking | `components/AppErrorBoundary.test.tsx`, `app/frame-failure.test.tsx`, `app/App.test.tsx` (a page that fails) |
| NotFoundState | `app/pages/NotFoundPage.tsx` | **Adapt**: tokens, Link | `app/App.test.tsx` (unknown routes) |
| Button | none; the retry in `ErrorFallback` is a native `<button>` styled by a global `button` rule in `styles/app.css` | **New**; it replaces that global rule | new: §4.10 and §26 |
| Link | the router's `Link` and the `a` rule in `styles/app.css` | **New**, a thin primitive over the router link | new |
| Field, Input, Label, help, error | none | **New** | new: §6, §7, §26 |
| Alert | none; `ErrorFallback` uses a `role="alert"` element | **New** | new: §9 |
| LoadingIndicator | none | **New** | new: §10 |
| Tokens | the neutral custom properties at the top of `styles/app.css`, which its own comment says are not brand | **Replace** with the token file of DESIGN_SYSTEM §29.1 | the pairing test of DESIGN_SYSTEM §4.6 |

### 42.2 The bounded first implementation

A variant or size is built when a current screen first uses it (§30). The sections above specify the whole vocabulary so
that what is built later follows the pattern; they are not a build list. The showcase shows only what is built and is
not a reason to build a variant.

The foundation gate builds this, and nothing else:

- the token file, replacing the placeholder custom properties;
- Button: `primary` and `secondary` at `md` (the error retry, and the submit of the first form);
- Link: the default variant;
- Field, Label, help text, field error and Input at `md`, which the first identity screens need at once;
- Alert: `danger` and `success`;
- LoadingIndicator: the spinner and inline text;
- PageHeader, with the description and actions optional;
- the neutral frame restyled, and ErrorState and NotFoundState adapted;
- a development-only showcase of synthetic examples, whose code, route and data are absent from the production build
  (a build test proves it; hiding a link does not).

Not built: `tertiary`, `danger` and sizes `sm` and `lg` of Button; the other Alert variants; PasswordInput (identity
slice); the authenticated Ops shell; every deferred pattern in §37. The Product Owner confirmed this scope on
6 October 2026 (DESIGN_SYSTEM §36).

### 42.3 What was built (6 October 2026)

Paths are under `apps/ops-web/src/`. Tests sit beside each component; the browser tests are in `apps/ops-web/test/browser/`.

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| Tokens | `styles/tokens.css` | The one token source (DESIGN_SYSTEM §29.1), held to the document by `scripts/design-tokens.test.ts`. It adds the primitive `gray.550` (`border.control`, §4.6), the component token `--button-pressed-background` (the bare `#EAECF0` of the Secondary pressed recipe) and a layout width the frame already had |
| Frame, base styles | `styles/base.css` (replaces `styles/app.css`), `app/AppFrame.tsx` | Landmarks, skip link, focus after a navigation and the generic error copy are unchanged and keep their tests. The global `button` and `a` rules are gone |
| Button | `components/ui/button/` | `primary` and `secondary` at `md`. `type` is a required prop. `loading` sets `aria-busy` and `aria-disabled`, keeps the label and ignores activation, and does not use the native `disabled` (that would drop the button out of the keyboard order); `disabled` is the native attribute |
| Link | `components/ui/link/` | Default variant, a thin primitive over the router's `Link`, always underlined |
| Alert | `components/ui/alert/` | `danger` and `success`, an icon and words. `announce` is set only when the alert is inserted by something that just happened: `danger` then has `role="alert"` and `success` `role="status"`; otherwise it has no role |
| Field, Input | `components/ui/field/`, `components/ui/input/` | `Field` takes `label`, `help`, `error` and `required` and ties them to the control through context; inside a Field the Field owns the control's `id`. The error is text with an icon and is not a live region (§14 of the design system: focus goes to the first invalid field). `Input` takes the native attributes; read-only and disabled differ in look and in behaviour |
| LoadingIndicator | `components/ui/loading/` | A polite status region with a label (default "Loading…"); the spinner is decorative and optional. The router uses it as the `HydrateFallback` of the page area, so a page loaded on demand shows it inside the frame |
| PageHeader | `components/PageHeader.tsx` (beside `PageHeading`, not under `layout/`) | Composes `PageHeading`; `title`, optional `description` and `actions`; no breadcrumb yet |
| ErrorState, NotFoundState | `components/ErrorFallback.tsx`, `app/pages/NotFoundPage.tsx` | Now use Button and Link. The copy is unchanged, because the existing tests pin it and the specification wants the error `code` mapped to copy, not new wording |
| Showcase | `showcase/`, route `/__showcase` | Development only: `import.meta.env.DEV` removes the route and its import from a production build, and `test/build.test.ts` proves no trace remains. The component browser tests run against the Vite development server for that reason |

The first screens add a variant or size when they first use it (§30). The authenticated Ops shell, its navigation and the
inverse recipes stay with the identity slice; the frame and `PrimaryNavigation` still show no entries, because nothing
provides the caller's capabilities yet (DESIGN_SYSTEM §22).

---

**End of Melarc Component Patterns v1.1**
