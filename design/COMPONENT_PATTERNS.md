# Melarc Component Patterns

> **Status:** ACTIVE IMPLEMENTATION BASELINE — approved by the Product Owner on 6 October 2026; document only patterns that exist or are immediately being implemented  
> **Version:** 1.2  
> **Date:** 5 October 2026; revised 6 October 2026 to reconcile it with the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md) (§4, §9, §12, §24, §33, §36, §40, §42), and on 5 November 2026 for the planned kit of the Ops Portal redesign (§1, §3, §12.6, §21, §22f, §37, §38, §40), and again that day in redesign step R2 for the heights, the side menu's current item, the Toast's actions, the table's rows and the token file's description (§4, §12.6, §21, §22, §42)  
> **Repository path:** `design/COMPONENT_PATTERNS.md`  
> **Depends on:** `design/BRAND_FOUNDATION.md`, `design/DESIGN_SYSTEM.md`  
> **Owns:** implemented or immediately planned UI component patterns, their anatomy, variants, states, accessibility expectations, density behavior, and usage rules  
> **Does not own:** product workflows, business rules, API contracts, domain-state semantics, logo artwork, or speculative future component APIs

---

**Approval (Product Owner, 6 October 2026).** This document is approved. A pattern that is built and tested (§42.3) is
ACTIVE: Button, Link, Field, Input, Alert, LoadingIndicator, PageHeader, the neutral frame, the error state and the
not-found state. A pattern that is not built keeps its status (PasswordInput became ACTIVE when S0.39a built it, §42.4; the
forbidden, empty, skeleton, status, table, select, dialog and alert-dialog patterns and the authenticated Ops shell when S0.40 to
S0.42 built them, §42.5, and the form page and the five pre-sign-in screens when S0.43 built them, §12.7 and §42.6), and the
deferred patterns stay deferred. The variants and sizes that are not built (§42.2) are
vocabulary, not a build list.

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

Future patterns such as drawers, menus, data grids, toasts, tabs, command palettes, charts, and complex navigation should be added only when real product requirements demand them (the dialogs and the date field have been: §20 and §22a). The Ops Portal redesign of 5 November 2026 is such a requirement for the planned kit of §37, recorded there as PROPOSED.

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
10. avoid product-specific business logic unless the component is explicitly a domain pattern;
11. take behaviour that no native element gives (a calendar, a menu, a searchable list) from the shadcn/ui primitives (Radix UI), through a
    component of `components/ui`, and never from a hand-built widget or a second library (DESIGN_SYSTEM §29.2). React Aria Components stays
    behind the components already built on it until they move (§37), and no new component is built on it (DESIGN_SYSTEM §24a).
    TanStack Table (the data model of the queue table) sits behind a component of `components/ui` on the terms of DESIGN_SYSTEM §23;
    Motion (animation) is not adopted.

---

## 4. Button

> **Status:** ACTIVE  
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

Working heights ([DESIGN_SYSTEM §11](DESIGN_SYSTEM.md#11-control-sizing), 5 November 2026):

| Size | Height |
|---|---:|
| `sm` | 36px |
| `md` | 44px |
| `lg` | 56px |

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

**Built (S0.41), because the AlertDialog's confirming button is one:** the outline recipe of
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §4.6, never a filled button: `status.danger.foreground` text and border on
`surface.default`, `status.danger.background` under the pointer, the pressed grey when pressed; busy and inert while loading like any
button. The recipe was marked proposed there; the owner confirmed it on 24 October 2026.

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

### 4.12 ButtonLink (S0.44)

A link drawn as a button, for going somewhere that is the main thing a surface offers ("Add a staff profile", "Reset authenticator"). It is
an anchor with an address, so it can be followed in a new tab and is announced as a link; an act that changes something is a Button, and
navigation that is not the point of a surface is a Link. It has the Primary and Secondary recipes and the same size and focus ring, and no
Danger, because a link never does harm.

---

## 5. Link

> **Status:** ACTIVE  
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

> **Status:** ACTIVE  
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

> **Status:** ACTIVE  
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

### 7.9 Select

> **Status:** ACTIVE (S0.41)
> **Code:** `apps/ops-web/src/components/ui/select/`

A native single-choice `<select>` at medium size, wired to a Field exactly as an Input is: it takes the Field's id, description,
`aria-invalid` and `aria-required`. The options are the caller's `<option>` children, so the platform's picker, keys and
type-ahead are kept, and nothing is drawn as an image (a strict content-security policy refuses a `data:` background, which is why
the arrow is the browser's). A first option that is not a choice ("Choose a reason") carries the empty value; the form, not the
control, says that a choice is required. It offers one choice: `multiple` is not part of the control, and a list that takes several is
another control and is not built. Invalid is a 2px danger border with the Field's icon and message; disabled differs in look and in
behaviour, as for an Input (§7.7).

### 7.10 Checkbox

> **Status:** ACTIVE (25 October 2026, for the trusted browser of [staff-authentication.md](../features/identity/staff-authentication.md) §5.8; **owner to confirm as a pattern**)
> **Code:** `apps/ops-web/src/components/ui/checkbox/`

One native `<input type="checkbox">` with a real `<label>` beside it, so that the whole phrase is the target, and optional help beneath
the phrase, linked with `aria-describedby`. It is a **choice the person makes and never a state the page decides**: it is off unless
the caller says the choice was already the person's (`defaultChecked`), and a form reads it at submit time (`fieldChecked`), not from a
copy kept in the page. The label states what ticking it means in a short sentence-case phrase (*Remember this browser for 7 days*), and
the help says what the choice does and does not do; neither is a placeholder for the other. It is drawn by the browser (so forced
colours, zoom and assistive technology behave as everywhere), 1.25rem square, tinted with the primary action colour, with the frame's
own focus ring. It takes no part in a Field, which is for a text control; a checkbox that needs an error says it in an Alert of the
form. It has no indeterminate state, no switch look and no group: a list of several choices is another pattern and is not built.

### 7.11 Textarea

> **Status:** ACTIVE (S0.60, for the verification note of `reregisterRiderDevice`; **owner to confirm as a pattern**)
> **Code:** `apps/ops-web/src/components/ui/textarea/`

The multi-line sibling of the Input (§7), for text a person writes in their own words that does not fit a line: how a rider's identity was
verified in person. A native `<textarea>` with the Input's recipe (the 3:1 control border, the same padding, type and states), wired to a
Field exactly as an Input is: it takes the Field's id, description, `aria-invalid` and `aria-required`, and on its own needs a name from
`aria-label`. It starts at three rows (`rows` changes that), grows only downwards (vertical resize, never wider than its container), and its
height is a minimum in rem so enlarged text is not clipped. Invalid is the 2px danger border with the Field's icon and message; disabled
and read-only differ in look and in behaviour, as for an Input (§7.7). It holds no value of its own, counts nothing and decides nothing
about what may be written: the screen says how long and what a note may hold, and the server refuses the rest. (The note of an
administrative act is one line with no control character, so a screen that uses a Textarea for one says so and refuses a line break.)

---

## 8. Password Input

> **Status:** ACTIVE (built in S0.39a, 23 October 2026; §42.4)  
> **Initial implementation priority:** Only when identity UI is implemented

PasswordInput extends Input.

### 8.1 Additional behavior

May include a show/hide control.

The visibility control must:

- have an accessible name;
- communicate current state;
- not alter the underlying password value;
- remain keyboard accessible.

As built it is an icon button (§22) with an eye, not a button with words: "Show password" (the open eye) and "Hide password" (the crossed eye).

### 8.2 Security

Do not:

- log password contents;
- retain password values unnecessarily;
- prefill secrets from application state unless browser/platform conventions explicitly require it.

---

## 9. Alert

> **Status:** ACTIVE  
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

> **Status:** ACTIVE  
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

> **Status:** ACTIVE  
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

> **Status:** the neutral frame is ACTIVE (`apps/ops-web/src/app/AppFrame.tsx`); the authenticated Ops shell is ACTIVE (S0.42, §12.6; its navigation is a side menu since 25 October 2026); the split screen of the
> pre-sign-in pages is ACTIVE (§12.7)  
> **Initial implementation priority:** the neutral frame is Required (it exists); the authenticated Ops shell was not part of the UI foundation gate

### 12.1 Purpose

Application Frame provides stable product structure without embedding business workflow logic.

There are three layouts, owned by route family, and they are not one component with optional parts. The families and
their rules are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §13.1 and are not repeated here. This section gives the anatomy
of each.

### 12.2 Anatomy

```text
NeutralFrame (AppFrame, layout `neutral`: an address that matches no route)
├── SkipLink
├── Banner (the logo and the product name)
└── MainContent (the route's page; focus moves to its heading after a navigation)

SplitScreen (AppFrame, layout `split`: the five pre-sign-in screens, §12.7)
├── SkipLink                      (the frame's)
├── AuthArt                       decorative photography over a band of Ink with the mark and the name; from 64rem, beside the form
├── Banner                        (the frame's: the logo, above the form)
└── MainContent                   (the frame's; focus moves to the new page's heading)

AuthenticatedOpsShell (AppFrame, layout `sidebar`: S0.42, a side menu since 25 October 2026)
├── SkipLink                      (the frame's)
├── SideMenu                      the mark and the name, PrimaryNavigation (an icon and a label for each entry from the registry),
│                                 the account card with the sign-out control; collapses to a rail, slides in on a narrow screen
└── MainContent                   (the frame's; focus moves to the new page's heading)
```

The pre-sign-in screens, the setup pages included, use the split screen (DESIGN_SYSTEM §13.1a). Exact navigation behavior
depends on the product surface.

### 12.3 Visual direction

Neutral frame: quiet, on `surface.page`, the logo and the product name, no Ink navigation. The split screen of the
pre-sign-in pages (§12.7) is the same frame with photography beside the form: the only Ink on it is the band under the
photograph, which is decoration, and it carries no navigation and no signed-in affordance.

Authenticated Ops shell: an application's frame and not a website's, so its navigation is a menu at the side and not a band
at the top (Product Owner, 25 October 2026):

- an Ink side menu, full height, that collapses to a rail of icons and slides in on a narrow screen;
- neutral working surface;
- the current item a solid crimson fill with white bold text (`shell.active`, DESIGN_SYSTEM §4.3 and §4.6);
- spacious shell;
- efficient content area.

### 12.4 Rules

Every layout must:

- preserve landmark semantics, the skip link and the move of focus to the new page's heading after a navigation;
- be chosen by the route tree and never by the page it contains;
- remain responsive.

The neutral frame and the split screen must never show, in any state (loading, challenge, error or success), navigation, a user menu,
sign-out, session data or anything loaded for a signed-in user. A `202` MFA challenge renders here, because it is not a
session. Tests assert this for each pre-authentication route as it is built (`pre-sign-in-neutral-frame.test.tsx` does, for the five
routes of §12.7, in each state they can be in).

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

### 12.6 The authenticated Ops shell as built (S0.42; a side menu since 25 October 2026)

> **Code:** `apps/ops-web/src/app/AuthenticatedOpsShell.tsx`, `app/navigation/route-registry.tsx`, `components/side-menu/`, `components/PrimaryNavigation.tsx`, `components/brand/BrandLockup.tsx`, `app/frame-chrome.ts`

**Shell v2 (PROPOSED, §37).** The approved redesign (Product Owner, 5 November 2026) gives the signed-in shell a top bar and a sidebar of seven groups ([surfaces/ops-portal.md §4](../surfaces/ops-portal.md#4-navigation-model)), built in redesign step R4. This section records the shell as built until then.

The Ops Portal is an application and not a website, so its navigation is a menu at the side and not a band at the top (Product
Owner, 25 October 2026, with a reference screenshot of a dark menu with icons, a red current item and an account card).

- **A layout route between the session guard and the signed-in routes**, and around nothing else: it is drawn only for a session the
  API has said is there and only for the routes of the registry. The neutral frame is not changed: an address that matches no route
  uses the frame with no menu, even for a person who is signed in.
- **The menu is drawn into the frame**, in the place AppFrame keeps beside the main content, and the route tree asks the frame for its
  sidebar layout (`useFrameLayout`): the frame then draws no banner above the page, because the menu carries the product's name. The
  order of the page is skip link, menu, main content. The menu is a landmark of its own (an `aside` named "Main menu", holding the
  `nav` named "Primary"), never inside the main content, and the skip link passes it. The frame's landmarks, skip link and move of
  focus are the frame's and are not copied.
- **One route registry** (`SIGNED_IN_ROUTES`) is where the signed-in routes and their menu entries are written, and the route tree and
  the menu are both derived from it: a route cannot exist without a decision about its menu entry (an entry, with its icon, or `null`
  for a screen reached from another) and about the key it needs (a permission, or any signed-in session); an entry cannot link a screen
  that does not exist, because nothing but a route makes one. A later task adds its screens there and nowhere else.
- **The menu is the entries of the routes whose key the session holds** (`CurrentSession.permissions`, keys only), by area and place;
  an unbuilt route has no entry even when its key is held. A hint never authorises: every route is behind `RequirePermission`, and the
  server checks every request. No role name or bundle is read anywhere in the navigation or the guards; the navigation tests carry
  the keys of each seeded bundle written out beside its name, held to the seed by a root test.
- **The Ink side menu** (§4.6, the shell recipe) is 16rem wide and as tall as the window, and stays where it is while the page
  scrolls. Its head is the symbol on a white tile and the product's name as plain text (the wordmark is never redrawn), with the
  collapse button. Each entry is an icon and a label (§22; DESIGN_SYSTEM §24): text `shell.text.muted`, and the current entry a
  filled item in the Primary action colour with white text (6.52:1), bold, and `aria-current`, never marked by colour alone. Focus
  uses the **inverse** recipe (`focus.ringInverse` outside a band of `focus.offsetInverse`), because the default ring is only 2.64:1
  on Ink. Its foot is the account card: the person's initials (decoration), their name, where they act (the hub's name, or how many
  hubs) and the sign-out icon button. The menu presents what it is given and knows nothing of sessions, permissions or routes.
- **On a wide screen (from 48rem) it collapses.** The button at its head ("Collapse menu", then "Expand menu", with `aria-expanded`)
  makes it a rail of icons 4.5rem wide: every entry keeps its name (the label is drawn out of sight and not removed) and a `title`, and
  the page takes the room. The choice lasts as long as the page and no longer: nothing is written to web storage, so a reload starts
  expanded. Enlarged text widens the menu with it, never past half the window.
- **On a narrow screen it slides in.** A slim bar with a menu button, the mark and the name stands in its place; the button slides the
  menu in over the page, behind a scrim. While it is open the main content is inert; Escape, the scrim, the close button and following a
  link close it. Focus goes to the close button on opening and back to the menu button on closing (a navigation leaves focus to the new
  page's heading, which the frame moves it to). Closed, it is out of sight and out of the tab order. A person who asked for reduced
  motion sees it appear and disappear without the slide.
- **It reflows.** The whole panel scrolls when the window is too short for it (enlarged text, a low window, zoom), instead of one part
  being squeezed until the account card spills out; the product's name goes under the mark, and the close button under the name, when
  they do not fit in a row. At 320px and at 200% text nothing clips and the page never scrolls sideways. Under forced colours the menu
  keeps an edge and the current entry a system highlight.
- **Sign-out** is an icon button ("Sign out") in the account card, on every signed-in screen. It calls `signOut` and ends the session by
  the one action that ends it (the same event that an answer of `SESSION_INVALID` raises), so the cache, the person and the screen go
  the way they always do. `204` and `SESSION_INVALID` are **done**; anything else (no connection, a fault, `CSRF_VALIDATION_FAILED`)
  leaves the person signed in with "Sign-out did not finish, so you are still signed in." and **Try again**, which is safe because the act
  is idempotent; "signed out" is never said while the session may be live. An answer for a session that was replaced meanwhile is dropped.
- **Who is signed in** is told by the account card and by the landing, each in its own words; a session with no display name is "Signed
  in" in the card and "You are signed in." on the landing.

### 12.7 The pre-sign-in screens as built (S0.43)

> **Code:** `apps/ops-web/src/app/pages/pre-sign-in/`, `platform/auth/`, `components/FormPage.tsx`, `components/auth-art/`

- **Five screens in the frame's split-screen layout** (changed 25 October 2026; they were in the neutral frame). `/sign-in`,
  `/sign-in/mfa`, `/setup/credential`, `/setup/mfa` and `/setup/mfa/complete` are siblings of the session guard (`PRE_SIGN_IN_ROUTES`) under
  one layout route (`AuthSplitLayout`), so none of them is wrapped in the authenticated shell, and the setup screens use the same layout
  (DESIGN_SYSTEM §13.1, §13.1a). None draws navigation, a user menu, sign-out or session data in any state, and none asks the API for a
  session: the only requests on the wire are the operation the person is performing.
- **The split screen** draws the photography beside the form from 64rem: `AuthArt` in the place the frame keeps beside the main content,
  the banner (the logo) and the main landmark in the other half. The photograph is decoration, hidden from assistive technology as a whole,
  with no alternative text, and holds nothing that can be reached or operated; under the band of Ink at its foot are the mark and the name
  as text. Which photograph goes with which screen is one table (`auth-art.ts`, a test holds it to the five screens and to the copies in
  `assets/auth/`, which have no metadata and are recorded in their README). It is loaded lazily, so a screen too narrow to draw it never
  fetches it.
- **A form page** sits in the column of the split screen (at most 30rem; the 560 to 720 px of DESIGN_SYSTEM §13.3 yields to the half of a
  split screen, §13.1a). When a state replaces the form (an ending, a used grant) the button the person pressed has gone with it, so focus
  moves to the new state (`FocusedRegion`) and its alert is announced.
- **"Show password" is an eye.** The password field's visibility control is an icon button (§22): the open eye when the password is
  hidden ("Show password"), the crossed eye when it is shown ("Hide password"). It has no text of its own, keeps focus when pressed and is
  announced when it changes what is on the screen.
- **The password step has one refusal** (`/sign-in`). A wrong password, an unknown address, an ineligible identity and a lock are one
  sentence, "The email or password is not correct.": the page has no locked state, and any refusal it was not told how to word reads
  as a wrong password. A wait, an Origin that could not be verified, a request that got no answer and a refusal of a field are worded as they
  are. The password is emptied after every answer that is not a sign-in and focus returns to it; the email stays.
- **The second step is not the application.** A privileged sign-in is answered with a challenge, which the page holds in memory and uses
  to complete the sign-in. Four refusals are four states and are not merged (a wrong code keeps the attempt open and shows no count; a
  finished attempt, a slow one, a lock and a missing authenticator each end it, forget the challenge and offer signing in again); the lock
  is told here and nowhere earlier. A visit with no challenge goes back to the first step.
- **A link page reads its grant once** (`useGrantToken`, `platform/auth/`). The grant is in the fragment (`#token=…`): it is read in the
  first effect, the fragment is removed by *replacing* the history entry whatever it held, the token is kept as a transient secret and is
  sent only in the body of the one request that redeems it, with the real `Origin` and no referrer (`NoReferrer`). Opening the page
  redeems nothing: the person presses the button. One page, `GrantProblem`, answers a link with no grant and a grant that cannot be used,
  whichever way, and does not re-open the form.
- **The authenticator screen** shows the QR code and the key to type by hand together (the key is the accessible alternative), once, from
  memory, with the field for the code that proves them. It is never a link, never has a copy button and holds no field a form would
  send. A wrong code says the authenticator is not set up yet and keeps the picture; only a proven code ends the setup, and the
  confirmation says the next step is an ordinary sign-in and that nobody is signed in.
- **What two screens hand each other lives in memory** (`PreSignInFlowLayout`): the sign-in challenge, and the authenticator's
  material with its continuation grant. It is let go of when the person leaves the family of addresses it belongs to, when the page is
  hidden, when the session changes and after the longest a page may hold a secret; never in the address, the history state or a storage.
- **Copy** is keyed by operation, context and code in `problem-copy.ts`. The context `unknown-outcome` words a command that got no answer,
  where a single-use grant or code may or may not have been spent, and says what to try next. The wording is proposed for the Product
  Owner to review with the composed screens.

### 12.8 The six signed-in identity screens as built (S0.44)

> **Code:** `apps/ops-web/src/app/pages/staff/`, `app/pages/LandingPage.tsx`, `platform/staff/`

- **Six screens behind the registry** (`SIGNED_IN_ROUTES`): `/` (the landing), `/admin/staff` (the list and the approver's queue),
  `/admin/staff/new`, `/admin/staff/{id}`, `/admin/staff/{id}/mfa/reset` and `/admin/sessions`. Each names the permission key its guard needs
  and, for the first three and the sessions page, a menu entry with a line of what it is for (the landing lists them). The detail and the
  reset are reached from a profile, so they have none. A profile also leads to the sessions page with the person chosen; opened from the menu
  it asks for one.
- **The list opens on what the person came for**: the queue for a session that can approve, everyone for one that cannot. The view and the
  search are in the address, so a link (the landing's "Review the queue") and Back mean what they say; the page of results is not, because a
  token is good only for the list it was given for. *None waiting* and *the filter hides everything* are told differently; a count is exact only
  when the whole queue is on the page, and is never shown while the list is loading.
- **A profile is read once and the page acts on the version it read** (`WithProfile`, `If-Match` exactly as the server sent it); a second
  read of the same profile on mount would change the version under the person's hand. A profile in a hub the session does not act in and one
  that is not there are two pages of their own. The status is a badge and a sentence; the role comes from the assignable list when the session
  may read it (otherwise the row is left out, not shown as "Another role"); no id is ever shown.
- **Only what can be done is offered, and a hint is not the authority.** The actions follow the status and the held keys: approve and reject a
  profile that waits (not the maker's own, which says so), a new setup link for an active one, the reset of an authenticator when
  `mfa_reset_state` allows it, the person's sessions. The server refuses what it should whatever the page showed. **Recovery of a credential is
  not here**: its operation is not built.
- **Approving is a confirmation, rejecting is a reason.** Approving gives access, so it is `ConfirmationDialog` with a primary confirm;
  rejecting, sending a link, resetting an authenticator and ending a session ask for a reason from the catalogue of that act (`operation`, and
  the `branch` the record names) over `ReasonConfirmationDialog`. After an act the dialog closes, the news says what happened, focus moves to
  it, and the record is read again.
- **No page that acts on another principal's credential has a field that could show one.** The answers of a re-issue and of a reset are judged
  to a handful of facts (how many sessions ended, whether a link was sent, when it lapses) and the link is never read; a structural test fails
  on any import or name that draws, holds or reads a credential in these screens, and each screen's tests plant one in the answer.
- **The create form has no password, no status and no creator** (the schema has none). The role is chosen from the server's list by name; a
  form that cannot name a role is not drawn. Creating takes an `Idempotency-Key`, so a lost answer is tried again under the same key; the
  success says the profile is waiting for approval and that a different approver is needed unless the maker is a Platform Admin.
- **Sessions** are asked for one principal, named by the address; opened with none the page asks for a person first. A refusal of the tier is
  told plainly; ending a session that had already ended reads as done; the list is read again after every close of the dialog.
- **Time** is shown as the design system says (§40): 24-hour in Accra with no label (`formatInstant`), whatever the machine's zone.

### 12.9 The four rider screens as built (S0.60)

> **Code:** `apps/ops-web/src/app/pages/riders/`, `platform/rider/`

- **Four screens behind the registry**: `/admin/riders` (the roster; `dispatch.read`; one menu entry), `/admin/riders/{id}` (one rider and the
  version the device acts take), `/admin/riders/{id}/device/register` (`staff.device.register`) and `/admin/riders/{id}/device`
  (`staff.device.revoke`; replacing a handset is offered inside it to a session that holds `staff.device.reregister`, and the page names the
  permission each act needs, never a role). The last three are reached from a rider and have no menu entry.
- **Identity and readiness only.** A rider is a name, a phone, a status, a hub, whether a PIN is set and whether a device is `ACTIVE`; a device
  is its state and when it was registered. No page has a field for a PIN, a hash, a key or an attestation, and the shapes read those fields and
  no other (`rider-shape.ts`). A structural test fails on any import or name that draws, holds or reads one in these screens.
- **The QR is the credential and is held like one.** The enrolment URI of a registration is drawn as modules by the S0.39c primitive and is in no
  text, attribute, link or copy button of the page. It lives in memory only (`useTransientSecret`: never a query, a mutation, a storage, the
  address, the history or a log), for the lesser of the grant's lifetime and fifteen minutes, and is gone on navigation, on completion, when
  the page is hidden, when the session ends and when its time is up. A code that has lapsed is never left on screen: the page says so and offers
  a new one. The officer never receives the rider's PIN or key; the code is useless without the handset's hardware attestation.
- **The first binding is told apart from a replacement.** A rider with no device held is registered; one with an `ACTIVE` device, or a revoked
  one, is replaced (`STATE_CONFLICT` on a first registration is explained and points at the replacement). Registration takes an
  `Idempotency-Key` and no version, so a lost answer is tried again under the same key; a replacement takes the version of the read, a reason
  of the catalogue and a note, in a Textarea (§7.11), on how the rider's identity was verified in person.
- **Revoking is a report and is not made slower.** It asks for a reason and a confirmation, takes no version and no verification, and says that
  it ends the rider's live session. A rider with no `ACTIVE` device has nothing to revoke, and the page says so.
- **Where focus goes, and the way out of a doubt.** The button that asks for a code is gone once the code appears, so focus goes to the code's
  region (a screen reader reads from its heading), and to the news when a code has lapsed. When it is not known whether a code was made, the
  page offers to look at the rider and, only for the first binding (it takes a key), to try again under the same key; a replacement offers the
  look alone, because a new code ends the old one. Each branch of the replacement form has a key of its own: without one, React gives the next
  branch the button the click was on and changes its type to `submit` before the browser acts on the click, and reading the rider again would
  ask for a code (found in Chromium, which jsdom cannot show).

---

## 13. Error Page

> **Status:** ACTIVE  
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

> **Status:** ACTIVE  
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

> **Status:** ACTIVE (S0.40)  
> **Code:** `apps/ops-web/src/components/ui/forbidden-state/`

### 15.1 Purpose

Tell a person, in words, which refusal of authority they met and what it is about. The three refusals of authority are different
bugs with different fixes ([errors-and-enums.md](../contracts/errors-and-enums.md) §4), so they are told differently.

### 15.2 Kinds

| Kind | Meaning | Names |
|---|---|---|
| `permission-missing` | The session does not hold the permission the page or part needs (`PERMISSION_DENIED`) | the permission key (required) |
| `insufficient-authority` | It holds the key, and this target or state needs a higher authority (`INSUFFICIENT_AUTHORITY`) | the key, if one can be told |
| `outside-hubs` | The record exists in a hub the session does not act in (`HUB_SCOPE_VIOLATION`) | nothing |
| `approval-required` | A different approver, one who holds the permission, decides this (`SELF_APPROVAL_FORBIDDEN`) | the key, if one can be told |
| `unavailable-here` | The act is not available for this record as it stands | nothing |

### 15.3 Rules

- It names the **permission key** and never a role ([surfaces/ops-portal.md](../surfaces/ops-portal.md) §7). A refusal for a missing
  permission cannot be drawn without the key: the type requires it.
- Two forms, by composition: `ForbiddenState` is an Alert in the page, for a part of a page that cannot be had (the reason list
  that a session may not read); `ForbiddenPage` is a whole page, with its own title and the page's one level-one heading, for a
  route the session may not open. `RequirePermission` renders the second and does not render the page at all.
- It is presentation. Hiding a control, or refusing a page here, is not enforcement: the server refuses again on every request
  (§25).
- The wording is approved presentation copy, never the API's diagnostic `message` (§33).

---

## 16. Empty State

> **Status:** ACTIVE (S0.40)  
> **Code:** `apps/ops-web/src/components/ui/empty-state/`

### 16.1 Anatomy

```text
EmptyState
├── icon (decorative)
├── heading (level 2 to 4, the page's outline decides)
├── explanation
└── action (optional; required when filtered)
```

### 16.2 Rules

- It tells **none** from **filtered to nothing**, because conflating them sends Ops hunting for a bug
  ([surfaces/ops-portal.md](../surfaces/ops-portal.md) §7). `none` is a success message in the success tone: a queue worked to
  empty is the goal. `filtered` is neutral, and the type requires an action, because the only useful thing to do with a filter
  that hides everything is to take it off.
- The words are the screen's. The component fixes none, and never shows example rows or a count of `0` for a list still
  loading (§24.1).
- `announce` is set only when the empty result appears because of something that just happened, such as a filter: it is then
  a polite status. One that is part of a page that loads is read in order like any other text.

---

## 17. Skeleton

> **Status:** ACTIVE (S0.40)  
> **Code:** `apps/ops-web/src/components/ui/skeleton/`

A placeholder of the shape of content that is on its way, so that the layout does not jump. It is **decoration**: `aria-hidden`,
no words, no role, always beside a `LoadingIndicator`, which is what says that the page is loading. It pulses, and stops under
`prefers-reduced-motion: reduce`; under forced colours it keeps a border. `lines` is a whole number from 1 to 20 and anything
else throws, because a placeholder of a million lines is a defect of the page.

Use it only where the layout is predictable and the wait is long enough to justify it. A table, a list and a detail page are;
a button is not.

---

## 18. Status Badge

> **Status:** ACTIVE (S0.40)  
> **Code:** `apps/ops-web/src/components/ui/status-badge/`

```text
domain enum
    ↓
presentation mapping (the feature's, typed over the whole enum)
    ↓
status tone: success · warning · danger · info · neutral
    ↓
StatusBadge (words in the tone)
```

- The badge **knows no domain value**. A feature writes a `StatusMap<Value>`: a tone and the words for **every** value of the
  enum, so a value the contract adds is a compile error where the mapping is written until someone decides how it looks.
- The words carry the meaning and the tone supports them (§4.6 pairings: the foreground on its soft background, as an Alert
  has it). Colour is never alone.
- A value the mapping does not have (a newer server, a mapping not yet updated) is shown **neutral as "Unknown status"**, never as
  the raw value and never in a colour that means something. The lookup finds own properties only, so `constructor` and
  `__proto__` are unknown values like any other.

---

## 19. Table

> **Status:** ACTIVE (S0.40)  
> **Code:** `apps/ops-web/src/components/ui/table/`

### 19.1 Anatomy

```text
Table
└── region (named, focusable, scrolls sideways)
    └── <table> with <caption>
        ├── <thead>  column headers; sortable ones hold a button and carry aria-sort
        └── <tbody>  rows; the cell that names a row is a row header
```

### 19.2 Rules

- A **native table** with a caption. The caption names the table and the region; `hideCaption` takes it from the eye and not from
  assistive technology, where the page's own heading already says it.
- Rows are at least 36px (`density.row.compact`, [DESIGN_SYSTEM §10](DESIGN_SYSTEM.md#10-density-system)), in rem so that enlarged text grows them.
- A column of numbers is aligned to the end and set in figures of one width.
- **Sorting is the screen's**: the header button asks for an order (`ascending` first, then it toggles; another column starts
  ascending) and `aria-sort` says the order that is shown, on the sorted column only. The table sorts nothing. A sortable column
  with nothing to sort with, a duplicate column or row key, and two row-header columns are defects of the page, and drawing
  them throws.
- **Overflow is intentional**: a table narrower than 30rem scrolls inside its region instead of squeezing its columns, the region
  has a name and takes focus, and the arrow keys scroll it. The page never scrolls sideways for a table (WCAG 1.4.10 allows a data
  table to scroll).
- It draws only its header for no rows. What to say about none is the screen's (§16), and the states around it are
  `ReadState`'s (§33.3).
- It is **not a data grid**: no selection, paging, filtering, resizing or virtualisation. A requirement that needs one is a new
  pattern (§37).

---

## 20. Dialog and AlertDialog

> **Status:** ACTIVE (S0.41)  
> **Code:** `apps/ops-web/src/components/ui/dialog/`, `reason-confirmation/`, `apps/ops-web/test/setup-components.ts`

### 20.1 The primitive, chosen deliberately

The platform's own **`<dialog>` opened with `showModal()`**. It adds no dependency (a new one is a stop condition), and it gives, for
nothing: the top layer, a page behind it that is inert (no focus by Tab or by script, no click), Escape as a `cancel` event, and a
backdrop to draw. What it does not do, the component does:

| Behaviour | Rule |
|---|---|
| Opening | The page's `open` prop. The element is always in the page and is opened and closed with it; a `close` the browser made on its own (a second Escape on an untouched page is not cancelable) is told to the page, and a dialog the page still wants is opened again. |
| Initial focus | The control marked `data-initial-focus`; otherwise the browser's, the first focusable. An alert dialog marks its **safe action**. |
| Return of focus | To the element that had it when the dialog opened, on every way of closing, unless that element is gone. |
| Escape | The `cancel` event is prevented and the page is asked (`onRequestClose`). A dialog given none cannot be dismissed. |
| Backdrop | **Never closes it.** What a person typed would be lost to a stray click, and a state they must see could be hidden. |
| Content | Drawn only while open, so a dialog opened again starts clean. |
| Scrim | `--color-surface-inverse` at 55% by `opacity` on `::backdrop`: no new colour, and no token to add. |
| Size | `min(32rem, 100vw - 2 × space.4)`; it scrolls inside itself, so enlarged text and 320px never push it off the screen. |

jsdom has no `showModal()`, `close()` or `returnValue`, so `test/setup-components.ts` supplies enough of them for a component test
to drive a dialog (open state, the `cancel` on Escape, the queued `close`, initial focus). **What jsdom cannot show is proved in a
real browser, in three engines** (`test/browser/dialogs.spec.ts`): that the page behind is inert, that Tab stays inside, the
scrim, and the return of focus.

### 20.2 AlertDialog

For a question that interrupts: a high-risk confirmation, and never for information. A title that is a question, the consequence in
words (the dialog is described by it), **Cancel** (focused first) and a confirming button that **says what it does** ("Reset the
second factor", never "OK"), in the Danger treatment (§4.7). Enter confirms from a field. While the act is under way the confirming
button is busy, Cancel is not offered and Escape does nothing.

### 20.3 Reason and confirmation workflow

`ReasonConfirmationDialog` holds what the identity screens share, so that none gets a part of it wrong:

- the reasons are `listReasonDefinitions` for the action, filtered by `operation` and `branch` (the branch from the record's
  `mfa_reset_state`, never from `mfa_enrolled`); no reason code is invented and no second catalogue is kept; if they cannot be
  had, the act cannot be confirmed;
- a note is mandatory when the chosen reason says so; it is one line of at most 1000 UTF-16 code units with no control character,
  sent **as typed** (blank is none); the page checks only what it can, and the server screens the rest (email addresses,
  telephone numbers) and the page puts its refusal on the note;
- the command is everything that makes the request what it is, **with the version the person saw** (`If-Match`), held as a copy;
- **an unknown outcome** (no answer, an answer that is not the API's, a fault) keeps the dialog, locks the reason and the note,
  ignores Escape and offers a way out: **Check the record** (abandon the attempt, read the record again) always, and **Try again**
  (the same command under the same key) only for an act that can safely be sent again — one that takes an `Idempotency-Key`
  (§33.2). The nine identity operations take none, so for them the way out is the record;
- an act whose operation has **no note field** (the report of a lost device, which `DeviceRevocation` makes a reason and nothing
  else) is drawn with `withNote={false}`: the dialog shows no note, never asks for one and sends none, so that a person is not
  asked for what cannot be sent and never believes a sentence they wrote was kept. The reason is still asked for, and a reason
  that wants a note is not a dead end: the server judges it;
- a **refusal** ends the attempt: the dialog and the input stay, what is wrong is put on its field and in the Ops Portal's words, and
  the next submit is a new command;
- **`STATE_CONFLICT`** says the record changed, and the way on is to read it again.

### 20.4 ConfirmationDialog (S0.44)

The confirmation of an act that needs no reason, over the same machinery as §20.3 (`useConfirmedCommand` and the shared outcome parts in
`command-outcome.tsx`), so that a lost answer, a moved record and a changed session mean the same in both. Its confirming button is
**primary** by default, because an act that gives something (approving a profile gives access) is not harm; the reason dialog's default is
the danger treatment, because most of what asks for a reason is harm, and either takes `confirmVariant`. A colour that warns of harm where
there is none teaches people to ignore it.

---

## 21. Toast

> **Status:** PROPOSED (the planned kit of §37; it was DEFERRED until the redesign of 5 November 2026)

The Product Owner decided one workflow on 5 November 2026: the success of a task lands as a toast with "Open" and "Do another" ([PRODUCT_DESIGN_DIRECTION §6.3](PRODUCT_DESIGN_DIRECTION.md#63-task-form)). **A toast that carries actions does not time out** (approved the same day, so that a person has the time to use the action, WCAG 2.2.1): it stays until an action is taken or it is dismissed. Before the toast is built (redesign step R5) it still has to establish:

- what other messages are transient;
- which messages must remain persistent;
- accessibility/live-region behavior.

Important business outcomes must not exist only in disappearing toast messages.

---

## 22. Icon Button

> **Status:** ACTIVE (25 October 2026: the eye of the password field, and the controls of the side menu and its account card)

A native `<button>` named by a required `label` and drawn with one icon of the family (DESIGN_SYSTEM §24; the registry is
`components/ui/icon/icons.ts`). It is the only way to make an icon-only control (`components/ui/icon-button/`).

- icon-only controls require accessible names: `label` is required and is the accessible name, and it names the act ("Show password",
  "Collapse menu", "Sign out"), not the picture;
- a tooltip may improve discoverability but does not replace the accessible label: the `title` repeats the name for a pointer user, and
  no custom tooltip is built, because one that appears on hover or focus must be dismissible, hoverable and persistent (WCAG 1.4.13);
- target size stays usable: at least 2rem square, above the 24px of WCAG 2.2, and it grows with enlarged text;
- icon meaning must be conventional or otherwise clear: an eye to show, a menu, a cross to close, chevrons to collapse and expand, an
  arrow out of a door to sign out; the same meaning has the same picture everywhere;
- `bare` on a light surface and `inverse` on Ink, where the focus ring is the inverse recipe; `loading` keeps the name and the place,
  ignores activation and shows a spinner (`aria-busy`, `aria-disabled`, and not the native `disabled`, which would drop it from the
  keyboard order);
- its state is kept in its name or in `aria-expanded` and `aria-pressed` passed to it, never in the picture alone.

---

## 22a. DatePicker

> **Status:** IMPLEMENTING (28 October 2026: built and proven in the showcase, and reviewed the same day, with the runs recorded in [the plan's §7.50](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026); ACTIVE when a screen first uses it and the Product Owner accepts its look)  
> **Code:** `apps/ops-web/src/components/ui/date-picker/`

One calendar date, typed by its day, month and year or chosen from a calendar that opens under the control. Its behaviour is React Aria
Components' (DESIGN_SYSTEM §24a); its properties and its look are the portal's. It is the one component still built on that library, and
the plan for it is the phase-out table of §37.

### 22a.1 Anatomy

```text
DatePicker (inside a Field)
├── group    named by the Field's label, described by its help and error
│   ├── day, month, year    three editable parts, each its own stop for Tab
│   └── calendar button
└── calendar    a popover holding a dialog: the month, previous and next, the days
```

### 22a.2 Rules

- **The value is text.** `value` and `onChange` are `YYYY-MM-DD` or `null`; `minValue` and `maxValue` are `YYYY-MM-DD` or left out. A page never
  sees a date object of the library. Text that is not a date of the calendar (`2026-02-30`) is drawn as no date, never as another one.
- **When the page hears.** `onChange` gives a date once it is whole and real, and `null` when every part is cleared. While a date is typed
  the page hears each whole date on the way (the year 2, then 20, then 202, then 2026), so what it holds is checked and never trusted. A
  person who clears one part of a whole date and leaves the control would leave the page holding the date it last heard of and the control
  blank in a place, and would submit it: on leaving, the control tells the page `null` and starts again from none. Moving between the parts,
  to the calendar button or into the calendar is not leaving, and neither is the window losing focus (another window, the address bar): focus comes back to a control as it was left. A read-only or disabled control, and a value that is not a date, are never reconciled. A year typed in two digits is that year (26 is the year 26, shown as 26):
  nothing guesses a century, and the page's check refuses it. A date that does not exist (30 February) is moved to the nearest real one when
  the person leaves, and that is given.
- **`minValue` and `maxValue`** draw the days outside them as unavailable in the calendar, where they cannot be chosen; a date typed outside
  them is still given. They are hints about what is worth choosing, never a rule: the page checks what it can and the server decides
  (sections 24 and 25). Which days a pickup can be booked for (Monday to Saturday, the cut-off, the zone's days) is the page's question and
  the server's answer, not this component's.
- **Language and day.** Day, month, year; the week starts on Monday; English month names; fixed by the portal and not the browser's
  (DESIGN_SYSTEM §24a). Today is the day in Accra and is told by more than colour: bold, with a bar under the number. (A screen reader's word
  "today" is the library's and follows the machine's zone: a known edge for a machine outside Ghana.)
- **Inside a Field** it is named by the Field's label (`aria-labelledby`, because the control is not one labelable element; the Field
  exposes its label's id), described by its help and error, invalid when the Field has an error (a 2px danger border, with the Field's icon
  and message, so the red is never alone) and required when the Field says so. On its own it needs `aria-label`.
- **States.** Empty (it shows `dd`, `mm` and `yyyy`), filled, focused (the global ring, on the part, the button or the day that has focus),
  invalid, read-only (legible and focusable, no calendar: its parts are not styled as disabled, and its calendar button is, since it does nothing) and disabled (not focusable, no calendar). A day is today,
  selected (the fill of Primary and bold, so not by colour alone; the system's highlight under forced colours), hovered or unavailable.
- **Keys** (the library's): Tab walks the parts and the button; digits type and move to the next part; the arrows step a part; Backspace
  takes a digit; Enter or Space on the button opens the calendar, which opens on the date, or on today; the arrows move by day and by week,
  Page Up and Page Down by month; Enter chooses and closes and focus returns to the button; Escape closes and changes nothing.
- **In a modal dialog** the calendar is drawn into the dialog (the page behind a modal dialog is inert, and the top layer is above the body): `Dialog` gives its element to what it holds, and the dialog lets an open calendar overhang its edge. The library marks the prop that sets the container deprecated; the use of it is the one noted in the code.
- **A label** that is not one element's (a date is three parts) leads to the first part when it is clicked, as a label leads to an input.
- **Size and reflow.** The control is at least `control.height.md` tall; the calendar button and the two month buttons are at least 2rem
  square; a day is a square of 2.5rem that shrinks, if it must, until seven fit across the screen, so that the week fits at 320px;
  everything is in rem, so enlarged text grows it; the calendar scrolls inside itself and never pushes the page sideways (WCAG 1.4.4 and
  1.4.10).
- **Motion.** The calendar fades in over `motion.normal`; under reduced motion nothing moves.
- **Not here:** a range of dates, a time of day, a date with a time (section 37), and a native `<input type="date">` anywhere in the
  application (a test fails on one).

### 22a.3 Proof

`DatePicker.test.tsx` (the keys the section names, but for Home and End, and each state, in jsdom), `test/browser/date-picker.spec.ts` (the keyboard,
the focus ring on each stop, WCAG 2.2 with the calendar closed and open and with an empty part focused, the looks that only the stylesheet
gives, the calendar inside a modal dialog, 320px, 200% text, forced colours and reduced motion, in three engines; forced colours in Chromium
and Firefox only, since Playwright cannot emulate them in WebKit) and
`test/browser/date-picker-policy.spec.ts` (a production build of the showcase under the strict content-security policy: no violation). The
recorded keyboard-only and screen-reader passes, as for every component, are not part of this.

---

## 22b. RadioGroup

> **Status:** IMPLEMENTING (S1.19, 29 October 2026: built, in the showcase and used by the pickup screens; ACTIVE when the Product Owner accepts the composed screens)  
> **Code:** `apps/ops-web/src/components/ui/radio/`

Mutually exclusive choices with the Field's rules (§6) applied to a group: a native `<fieldset>` named by its `<legend>`, of native radio
buttons, each with a real `<label>` and an optional line of help.

- **No default.** Nothing is checked until the person chooses: a choice the page made would be accepted unread, and a decision the contract
  wants made explicitly (a cancellation charge) is never preselected.
- The browser gives the keyboard: Tab enters the group at the checked choice, or the first, and leaves it in one stop; the arrows move and
  choose.
- Help and error are tied to every choice (`aria-describedby`). An error marks every choice invalid, so the form's focus goes to the group,
  and draws a 2px danger rule at the group's start with the Field's icon, which forced colours keep.
- A choice that exists and cannot be made here is `disabled`, and the group's help says why (the permission it needs): a greyed choice
  explains nothing by itself.
- Two choices with one value are a defect of the page and throw. What a choice means is the screen's.

## 22c. Picker

> **Status:** IMPLEMENTING (S1.19, 29 October 2026, as §22b)  
> **Code:** `apps/ops-web/src/components/ui/picker/`

A choice from what the server finds (the vendor of a booking, a returning sender by phone): a search field, the results as a list with a
button for each, and once one is chosen, that choice with a button to choose another.

- Native parts and no library: Enter in the field searches and never submits the form around it, Tab goes through the results in order,
  and a choice is the press of a button named with the result (`Choose: Demo Fabrics Ltd`), never a side effect of moving through a list.
- **The server searches.** The picker holds no list: the screen reads the server with the text and hands the read back, whose loading,
  failure, refusal (naming the permission) and empty answer are `ReadState`'s (§33.3). More matches than were returned are told as a
  reason to narrow the search, never shown as the whole.
- It never fills the field or chooses for the person. Focus follows the person: to the choice once made, back to the field when they set
  it aside. Required and error go on the search field, where the correction is made.

## 22d. MoneyAmount

> **Status:** IMPLEMENTING (S1.19, 29 October 2026, as §22b)  
> **Code:** `apps/ops-web/src/components/ui/money/`

An amount drawn from the integer of minor units the server sent (domain-model.md §3.2): `2550` GHS is `GH₵25.50`.

- Made on the digits as text and never in floating point, so no amount is off by a pesewa: thousands grouped, two places always, a leading
  minus for a negative amount. A value that is not a whole safe number is a defect and throws.
- **It computes and names nothing.** What the amount is (an indicative estimate, a charge as applied, a fee that became due) is said by the
  screen's words around it, and an amount the server did not give is never drawn (§24.1).
- Figures of one width, so amounts in a column line up. `pesewasFromCedis` turns typed cedis into the contract's integer, or refuses them
  (a third decimal place, a sign, letters), for a money input (§7.8).

## 22e. Timeline

> **Status:** IMPLEMENTING (S1.19, 29 October 2026, as §22b)  
> **Code:** `apps/ops-web/src/components/ui/timeline/`

Steps in the order they happened (the attempt chain of a pickup request), as an ordered list named by its label, so a screen reader says
how many there are and where each one is.

- The step the page is about is `aria-current="step"`, marked to the eye in words (`currentLabel`) and by a filled marker, never by colour
  alone. The markers and the rule between them are decoration.
- Static: it takes no focus of its own, and a link in a step is a stop in the list's order. The steps come oldest first and it sorts
  nothing; what a step says is the caller's. Two steps with one key, or two current steps, are defects and throw.

## 22f. QueueTable

> **Status:** IMPLEMENTING (S1.19, 29 October 2026, as §22b)  
> **Code:** `apps/ops-web/src/components/ui/queue-table/`

The queue workspace template ([PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace), approved on 5 November 2026) will supersede the presentation below, the pickup queue first (redesign step R7). This section records the queue as built, and `DataTable`, its successor, is PROPOSED in §37.

A page of a queue the server pages by token (surfaces/ops-portal.md §4): the count of the page, the rows in a `Table` (§19) and a pager.
`QueueFilters` is the named group of the screen's filters above it, in a row that wraps, so nothing is clipped at 320px or at enlarged text.

- **It never claims a total it was not given**: the count is of the page ("Showing 20 requests on page 2."), followed by "More follow on
  the next page." when the server gave a token, and no count is shown while loading.
- `useQueuePaging` keeps the tokens of the pages visited **for the filter that produced them**: a change of filter starts again at the first
  page, and no token is sent under another filter. Nothing is kept in the address or a storage. A screen that brings a person back to a queue
  they left may say where to start (`from`, once, and only for the filter the tokens were kept for) and may send them to the first page on
  purpose (`toFirstPage`); how long a place lasts, and whose it is, is the screen's (*Refresh and return to the queue*, below).
- After a move to another page, focus goes to the results once they are drawn, because the button that was pressed is gone while the
  page loads.
- Loading, failure and the empty state are `ReadState`'s, and the empty state tells *none* from *filtered to nothing* (§16). The filters
  filter nothing themselves; they stay in place while the queue loads, fails or is empty.
- **Row selection (S1.25, 3 November 2026).** `QueueTable` takes an optional `selection` (`QueueSelection`): a native checkbox for each row, in a
  column of its own at the start of the table headed "Select" and, in a queue given a `card`, at the head of each card with the word "Select"
  beside it. The queue **holds no selection**: the screen keeps which rows are chosen, by their keys (`rowKey`), so that a choice survives a move
  to another page of the queue, and the table draws the ones it shows and reports a tick or a clear (`onToggle`). Each box is named by the screen
  (`rowLabel`: "Choose ACC-PR-7KQ2MZ"); a row that cannot be chosen now (a limit is reached) is drawn disabled (`isDisabled`) and the screen says
  why in its own words, and a row that is ticked can always be cleared. The label around the box is the target, at least the height of a small
  control. The table decides nothing about what may be chosen, offers no "select all" (a choice of the whole page is a decision the screen has
  not been asked for) and draws nothing for a queue given no `selection`, which is drawn exactly as before. Because both drawings are in the
  page, each row has two boxes of one choice, and the stylesheet's `display: none` takes the one not shown out of the accessibility tree.
- **The manifest list (S1.25) adapts the queue's filters and keeps its place on the queue's terms.** It uses `QueueFilters` with the same `Field`, `Select` and `DatePicker`, the chosen values in the address (so a reload keeps them), a change of filter starting again at the first page, and the same empty states (*none* told from *filtered to nothing*, which names what was filtered). The filters are the server's (`state`, `service_date`, each exact and combined as "and"): a value in the address that is not one is no filter, and the screen sends only values the contract accepts. Its place (the pages visited, the position and the manifest opened) is the queue's memory (*Refresh and return to the queue*, below) with the same rules of what is kept, for whom and for how long: one mechanism (`queue-continuity*.ts`, `QueueContinuityScope`, `useQueueContinuity`) holding a place for each list apart from the other's, so that a place left in one is never offered to the other. A manifest's page, and its not-found and refusal pages, keep the link back.

### Queue presentation (the pickup queue, 1 November 2026)

The first queue drawn to [PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace) (focused results, compact filters), from the
owner's reference of that date (`design/reference/MELARC_PICKUP_QUEUE_REFERENCE_2026-11-01.html`, a design proposal and not code). It changes
how a request is drawn and nothing the queue reads, asks, orders or allows. Code: `apps/ops-web/src/app/pages/pickup/` (`pickup-queue-view.tsx`).

- **Header and filters.** One heading, one short sentence of scope, the permission-gated action beside the heading, and the screen's own
  filters in one wrapping row. No totals, counts by status, charts or cards of figures.
- **One panel** (`QueuePanel`, `queue-table/`). The filters, the count of the page, the rows (as a table or as cards) and the pager are one white
  surface with one border (`radius.lg`, the subtle border token) and a hairline between each part, and not a box for each; what the rows
  draw inside it gives up its own border and corners. Whatever stands in the place of the rows (the loading and its placeholder, an empty
  state, a failure with its retry, a refusal) is inside the same panel, below the filters, inset from its edges by the filters' own space, and the
  rows run to the border. A queue given no panel (the approvals, the message log) is drawn as it always was.
- **The filters share a line.** Their fields align at the top, so that the State select and the date control are on one line whatever hangs
  beneath one of them (the date's help text stays, beneath its control), and the button that clears the date is set down to the control's
  line, not the help text's. A select in the filters takes no vertical padding of its own, because Safari's engine draws a native select 5px
  taller than the portal's other controls and the two would sit on different baselines there; every engine then gives it the control's height.
  They wrap, as before, where they cannot share a row (a phone).
- **Six columns for nine facts**, each named for what it holds. *Request / sender*: the operational code, the row's header and the one link of
  the request (the row is not a link), over the sender. *State*: the badge from the status mapping. *Service date*. *Pickup address / hub*: the
  address the server resolved for the pickup, over the hub. *Packages / booking type*: the count, over what is booked. *Needs*: the queue's own
  attention words, and for a request that needs nothing a dash that is read as "No additional note", which says nothing of blockers or of
  whether the request may go ahead. A missing fact says "Not recorded"; nothing is a tooltip. A cell's second line is the quieter one.
- **A fixed table.** The columns are percentages that add up to 100 and are tuned to the narrowest table drawn, so that the cells of a request
  keep their places from page to page; a long address or note wraps in its own column and rows have no fixed height. Cells align to the top.
- **Cards for a narrow room.** `QueueTable` takes an optional `card` for each row. The card is made from the same facts as the row, so that
  neither tells less, in the order a person reads a request: the code (a heading, so that a screen reader can move from request to request)
  with its state, the sender, then each fact under the name of its column. A term sits beside its value where there is room and over it where
  there is not. A queue given no `card` is drawn exactly as before (the approvals and the message log).
- **One drawing at a time.** Both are drawn and the stylesheet shows one, by a **container query on the results region** and not a media
  query on the screen: the docked menu takes 16rem (4.5rem collapsed), so the same screen gives a queue more or less room as the menu opens and
  shuts. The table is shown from 64rem (`breakpoint.lg`, written as a number because a query condition cannot read a token) and cards below it;
  `rem` follows enlarged text, so enlarging it gives way to the cards before the columns break. The one not shown is `display: none`, out of the
  accessibility tree and the Tab order, and the list says `role="list"` outright because Safari takes it from a list whose markers a style removes.
  Cards are the default and the table the exception, so a browser that cannot evaluate the query shows the layout that works at every width.
- **Not changed by the presentation.** The requests the screen sends, the server's order, the filters and their defaults (every state, every
  date), the permission and its refusal, the loading, empty, failure and validation states, and the paging with its focus move.

### Refresh and return to the queue (the pickup queue, 1 November 2026)

Both approved by the owner on 1 November 2026 (sections 3 and 4 of the reference above) and built for the pickup queue; the return to the place is built for the manifest list (S1.25) on the same terms, as that list's bullet above says. They add no polling,
no read on focus or reconnection, and no cursor in the address or in any storage, and they change nothing the queue asks of the server or the
order it gets back. Code: `apps/ops-web/src/app/pages/pickup/` (`PickupRequestListPage.tsx`, `queue-return.ts`); the memory is
`apps/ops-web/src/platform/pickup/queue-continuity*.ts` and `QueueContinuityScope.tsx`.

- **Refresh page.** A button beside the filters, outside their group (`QueueFilters` takes an `aside`: at the end of the filters' row where
  there is room, under them where there is not), with a line of text over it as a field has its label, so that the button sits on the controls'
  line. It reads the page now shown **again, by the same query**: the same filters, the same cursor and the same page number. It never goes to
  the first page; refreshing the first page is another act, and is the officer's.
- **The time.** "Last checked 3 Nov, 14:30" is the moment this page's read was answered, by the browser's clock, in the portal's time format
  (`formatInstant`: Accra, 24-hour, no seconds). It is not a server snapshot, and it says nothing of other pages or of the whole queue. A read
  that found nothing counts: it was checked. Nothing is shown before the page's read has been answered, and a change of filter or of page
  clears it until that query is answered (each filter and cursor is a query of its own). "Checking this page…" while a read is under way;
  "Refresh failed. Last successful check: 3 Nov, 14:30" after a failure, and nothing at all for a page that was never read.
- **One read at a time.** The button stays mounted and focusable and says it is busy (`aria-busy`, and it ignores a press) while any read of
  the page is under way; a press that reaches the page then is given that read, and neither cancels it nor starts another.
- **No old rows beside a new read.** While a page that was read is read again, the loading treatment takes the place of its rows, as for a
  first read, and a failure takes their place if the read fails; rows are never drawn as the answer to a read that has not come. The region
  carries no `aria-busy` of its own: the loading status inside it is what announces, and a busy region may hold its announcement back.
- **Focus and words.** Focus stays on the button unless the officer moved it. The completion is said once, politely, in a status region of the
  aside ("Page refreshed."), which is emptied when the next refresh starts, and **only of the visit the refresh was asked in**. A visit is the
  filters and the cursor the officer is on, counted anew each time either changes: coming back to a filter or a page they were on is a new
  visit, so the word is not said again over a read nobody asked for as a refresh, and an answer that arrives late, after the officer has gone
  elsewhere and come back, is said of nothing, during the newer read or after it.
- **Return to the place.** For a same-tab queue → request → queue visit the application remembers five facts and nothing else: the filters as
  the address carries them, the cursors of the pages visited, how far down the page the officer was, the request they opened, and the filters'
  signature. It keeps no row, code, name, address or state of any request, and no response. They are the state of `QueueContinuityScope`, a
  layout route inside `RequireSession`, **in the application's memory only**: not the address, not `localStorage` or `sessionStorage`, not a
  cookie, and of the history state only a flag that a link is a return. A full reload, a new tab or a typed address starts without it.
- **Whose, and for how long.** It is bound to the session, the person and the hubs they act in (`bindingOf`), and grants nothing: the server
  authorises the page it is asked for. It is let go of when the session ends or is replaced, when the hubs change, when the officer goes
  anywhere but the queue, that request and its pages, when the filter changes, on an explicit return to the first page, and once the queue has
  been shown again, whether it used the place or refused it.
- **When it is used.** On the browser's Back (or Forward) to the queue, and on the request's own link back ("Back to pickup requests", which
  names the queue's filters and says it is a return), the first time only: the arrival uses the place up, so Forward and Back again start at
  the first page rather than at a page the officer may no longer be on. The menu's link, a typed address and the booking ask for the queue
  anew and get the first page, as does a request opened in another tab (a click with a modifier, or a link that opens one, leaves no place).
  A request the server says is not there (`NOT_FOUND`: it went between the reading of the queue and the opening of the request), or refuses the
  officer (`HUB_SCOPE_VIOLATION`, `PERMISSION_DENIED`), keeps its way back like any other, because its page keeps the request's id for the
  link; an address that is not an id, and a request reached with nothing left behind, have the plain queue. The link of a refusal is offered
  only to a session that can read the queue, by the hints the menu and the route's guard go by (`pickup.read`): a session that cannot is given
  the forbidden page as every one is, with no link to another refusal, and the menu is its way on. The link grants nothing and says nothing of
  the request: it names the queue's filters, and the queue is read again under its own permission on arrival.
- **A fresh read, not a frozen one.** The saved cursor is asked of the server again by the same query and under the same cache policy;
  nothing is painted from memory, the rows are the server's current ones in its order, and a request may have moved or gone. It is continuity of
  place, not of a result set.
- **Position and focus.** Once the page is drawn the document is scrolled to the saved position (the browser clamps it to the content that is
  there now), and focus goes to the request the officer opened if it is still on the page (in the drawing that is shown, table or cards), else
  to the results, else to whatever stands in their place. The request is kept in view by the least scroll. Focus is given only where nobody
  put it (nothing, the document, the main region, the page's heading): an officer who moved it during the read keeps it, and still gets their
  position back.
- **A later page that holds nothing.** It says "No requests on this page" and offers "Back to first page"; it does not say the queue is empty,
  and it does not read the earlier pages on its own. A move to a page that comes back empty or failed puts focus on the message, once.
- **A page the server will not open** (`400 VALIDATION_FAILED` naming `page_token`) says so in its own words, keeps the filters, offers no retry
  (it would fail alike) and offers "Back to first page" (`ReadState`'s `recovery`). A refused filter keeps its own words and offers no such way.
- **Not built:** the Overview dashboard (a later task, with the backend data it would need assessed first), and a refresh or a place for any
  other queue than the manifest list (above: its place as the queue's, its *Refresh page* the button alone, without the completion word).

**Proof of §22g and §22h, and of the row selection of §22f.** Each component's own test (`ReorderList.test.tsx`, `QueueTable.selection.test.tsx`, and the
manifest page's tests for the rider picker, which need the API's reads), the development showcase, `test/browser/components.spec.ts` (the keyboard
walks and the showcase-wide WCAG 2.2 sweep) and the manifest screens in `test/browser/manifests.spec.ts`, run in Chromium; Firefox and WebKit are
left to the full run.

**Proof of §22b to §22f.** Each component's own test (its keys and states, in jsdom), the development showcase, and
`test/browser/components.spec.ts` (the keyboard walk, the focus rings, WCAG 2.2 at 320px and at 200% text, forced colours); the pickup screens
that use them in `test/browser/pickup.spec.ts`. S1.19 ran both in Chromium; Firefox and WebKit are left to the full run. The recorded
keyboard-only and screen-reader passes are not part of this. The refresh and the return are proved in
`PickupRequestListPage.refresh.test.tsx`, `PickupRequestListPage.return.test.tsx`, `QueueContinuityScope.test.tsx`, `queue-continuity.test.ts`
and `queue-return.test.ts`, and in the pickup spec (Chromium, Firefox and WebKit).

## 22g. ReorderList

> **Status:** IMPLEMENTING (S1.25, 3 November 2026: built, in the showcase and used by the manifest page; ACTIVE when the Product Owner accepts the composed screens)  
> **Code:** `apps/ops-web/src/components/ui/reorder-list/`

The stop-reordering control: an ordered list whose items each carry two buttons, to move the item up and to move it down, so the order is
changed from the keyboard and with a pointer alike. It is **controlled**: it keeps no order of its own and gives the caller the complete order
(every item once, as ids) after every move, because a sequence is sent whole and never as a change.

- **Two buttons are the whole of the control.** Drag and drop is not offered: nothing is lost for want of a pointer gesture, and the buttons are
  `IconButton`s (§22) named for the item and the act ("Move ACC-PR-7KQ2MZ up"), with their own focus ring and target.
- **A move exchanges the item with the nearest item that can move that way**, stepping over any item the caller marks `fixed`, which has no
  buttons, keeps its place and says why beside it (`fixedNote`), in words and not by colour alone. What may not be moved is the caller's to say;
  the list judges no item and no order, and the server's refusal is the caller's to show.
- **Focus follows the item.** After a move it stays on the button that was pressed, or on the item's other button when that end has been
  reached (the pressed one is then disabled), so a keyboard user can press again without finding their place. The button at an end is disabled.
- **Each move is announced** in a polite status region ("ACC-PR-7KQ2MZ moved to place 2 of 3."), and the place is written in the item as a number
  before it, not only in the order of the list. The list is an `<ol>` named by its label. Two items with one id are a defect of the page and throw.

## 22h. RiderPicker

> **Status:** IMPLEMENTING (S1.25, 3 November 2026: built and used by the assignment and by the custody handover; ACTIVE when the Product Owner accepts the composed screens)  
> **Code:** `apps/ops-web/src/app/pages/manifests/RiderPicker.tsx` (a composition of the Picker, §22c, for one purpose; not a generic component). The showcase draws the Picker over demo riders.

The Picker (§22c) over the riders the server lists (`listRiders`, `dispatch.read`), **asked for the active riders of one hub as filters of the
read, and not worked out in the browser**: the manifest's hub is the filter, because what the officer's grant reaches is not who may be given the
run. It opens with the list already drawn, so the officer chooses from what there is and does not have to guess a name; typing narrows it by name
or phone as the server matches them; more riders than the page returned are told as a reason to narrow the search, never shown as the whole.

- Each rider is told by the facts the roster returns and nothing of their work: name, phone, and, only when it is missing, "no PIN set" and "no
  registered device". These are facts and not a judgement of fitness; whether the server accepts the choice is its own answer
  (`RIDER_UNAVAILABLE`), and a rider it refused is set aside so that the same one is not sent again.
- It chooses nothing for the person and offers nothing by default: until a rider is chosen the dialog's confirmation asks for one.

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

Permissions and navigation entries are never inferred from a role name. The signed-in navigation entries come from
the `Session` resource's permission hints and the implemented route definitions, never for a feature that is not
built (DESIGN_SYSTEM §22; decided 8 October 2026).

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

What it holds since redesign step R3 (5 November 2026): two pages, and the production build contains neither (`test/build.test.ts`). `/__showcase` draws the components of `components/ui`. `/__showcase/primitives` draws every installed shadcn/ui primitive (DESIGN_SYSTEM §29.2) in the words a Melarc screen would use, with synthetic data, in both themes: a switch of the theme sits in its header and is held in memory, never stored (the stored choice is redesign step R4's, DESIGN_SYSTEM §31). A primitive is added to it in the change that installs it.

---

## 28. Component file organization

Exact paths depend on the implemented web app, but an initial structure may resemble:

```text
apps/ops-web/src/
├── components/
│   ├── primitives/      generated shadcn/ui source, on the tokens; no page imports it
│   └── ui/
│       ├── button/
│       ├── field/
│       ├── input/
│       ├── alert/
│       └── loading/
├── layout/
│   ├── application-frame/
│   └── page-header/
├── lib/
│   └── utils.ts         cn(), the one way class names are joined
└── styles/
    ├── tokens/
    └── tailwind.css     the names shadcn/ui reads, as references to the tokens
```

A page imports a component of `components/ui`; a component of `components/ui` composes a primitive of `components/primitives`; a primitive alone imports the library under it (Radix UI, cmdk, sonner, react-day-picker) (DESIGN_SYSTEM §29.2). The primitives are generated source, restyled through the tokens; a word, a variant or a state that belongs to the product goes in the Melarc component that composes one.

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

Copy is keyed by **operation, context and error code**, field errors included, in one place per surface: one global
message per code is often not enough (a `VALIDATION_FAILED` on a password field and on a reason select say different
things). An implementation may propose the copy; the Product Owner reviews the composed screens and not each phrasing
constant (decided 8 October 2026).

### 33.1 The nine interface states

The nine states are required by [surfaces/ops-portal.md](../surfaces/ops-portal.md) §8, which owns each requirement.
This table only says where each is presented.

| State | Presented by | Note |
|---|---|---|
| `loading` | LoadingIndicator (§10), with a Skeleton (§17) where the layout is predictable | a count is never `0` while loading |
| `empty` | EmptyState (§16) | a success message, not an error; says whether nothing exists or the filter hides it |
| `validation error` | FieldError (§6.5), and an Alert (§9) for a form-level summary | field-level, with recovery guidance |
| `error` | ErrorState (§13) or an Alert, with copy mapped from the machine code | never the diagnostic `message` |
| `retry` | a Button beside the error, separate from it | see §33.2 |
| `offline` | **not applicable** | the Ops Portal has no offline mode: lost connectivity is an `error`. Do not build an offline queue or a deferred-write interface |
| `stale / conflict` | an Alert (§9), written by the feature | `STATE_CONFLICT` explains what changed; the feature adapter owns it, not Button or Alert |
| `success` | an Alert, or the changed state of the page | confirms the state reached, not only that a request returned |
| `permission-restricted` | ForbiddenState (§15) | a clear refusal that names the permission; hiding a control is not enforcement |

### 33.2 Retry, rejection and unknown outcomes

A **rejected** request got an answer, so nothing is in doubt and the copy follows the machine code. An **unknown
outcome** is a timeout, a dropped connection or a failure after the request was sent: the server may or may not have
acted.

- Never retry a mutation automatically, and never present an unknown outcome as a success or as a failure.
- For an unknown outcome the copy says that the result is not known and how to find out (reload the record). It offers
  a retry only where the operation is idempotent under the contract: the retry reuses the same `Idempotency-Key` and the
  same payload, and a replay returns the original result. Where the operation takes no such key, offer to reload the
  record instead.
- An act that has words of its own for an unknown outcome (the rider screens' code that may or may not have been made) gives them
  to the shared outcome notice (`CommandOutcomeNotice`, `unknownText`) in place of the generic sentence; the way out the person is
  offered is the same, and still follows whether the act takes an `Idempotency-Key`.
- A failed read may be retried freely, because it changes nothing.
- Idempotency keys, version checks and conflict handling live in the feature adapter. Button, Alert and the other
  primitives know nothing of them (§24). The adapter is `useConfirmedCommand` (§20.3).

### 33.3 Reading the API: ReadState and the problem copy

> **Code:** `apps/ops-web/src/components/ui/read-state/`, `apps/ops-web/src/platform/problem/problem-copy.ts`,
> `apps/ops-web/src/test-support/interface-states.ts`

- **`ReadState`** is the composition of a read of the API in the states the screen owes: loading (a loading indicator, and the
  screen's skeleton beside it), the error in approved words **with a retry that is a control beside the error and not part of it**,
  the refusals of authority (§15, naming the permission), nothing at all (the screen's empty state), and the content. It shows
  nothing for a session that has ended or an answer for a session that has gone, because the session boundary has already taken the
  person away. It never shows the diagnostic `message`, never shows data of an earlier answer beside a failed refresh, and parks focus
  on its region when a retry takes its button away. A retry is offered for what could work (no answer, a fault, a rate limit) and not
  for a missing record or a refusal.
- **The problem copy** reads a failure as a kind (`forbidden`, `not-found`, `conflict`, `invalid`, `rate-limited`, `refused`,
  `unavailable`, `session-ended`, `stale`) and words it from a table keyed by **operation, context and code**; the most specific rule
  wins, and a rule for a whole operation does not speak over a code that has a meaning of its own. The generic wording is proposed
  for the Product Owner to review as part of the composed screens. A request id is shown as a reference, for a person to quote.
  A `rate-limited` problem of a signed-in call carries the wait the API asked for and holds the automatic reads for it; its words and
  its rules are [the Ops surface's](../surfaces/ops-portal.md#8-the-nine-interface-states).
- **The nine states are asked of every screen**: `describeInterfaceStates(screen, {...})` fails the screen's test unless each of the
  nine is tested or marked not applicable with a reason of a sentence. Offline is excused for every screen, once, in the words of the
  specification.

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

### Authenticated Ops shell (S0.42)
- [ ] landmarks correct: banner, navigation, main, in that order, the navigation outside the main content;
- [ ] navigation focus works, with the inverse ring on the Ink side menu;
- [ ] current location clear, by more than colour;
- [ ] no navigation entry inferred from a role name;
- [ ] no entry for a route that is not built, and none for a key the session does not hold;
- [ ] sign-out reads as done for `204` and `SESSION_INVALID`, and otherwise leaves the person signed in with a retry.

### ForbiddenState, EmptyState, Skeleton, StatusBadge (S0.40)
- [ ] a refusal names the permission and no role, in every kind;
- [ ] none and filtered-to-nothing look and read differently, and a filtered one has its way out;
- [ ] a skeleton is hidden from assistive technology, stands beside a loading indicator and stops under reduced motion;
- [ ] a status is words in a tone, the mapping covers the whole enum, and an unknown value is neutral and not echoed.

### Table (S0.40)
- [ ] a native table, named, with row headers where a cell names its row;
- [ ] sort buttons say their order with `aria-sort`, from the keyboard too;
- [ ] it scrolls in a named, focusable region, and the page never scrolls sideways at 320px or 200% text.

### Select, Dialog, AlertDialog, reason and confirmation (S0.41)
- [ ] a select is wired to its Field like an Input, and is reached and chosen from by keyboard;
- [ ] a dialog is modal, the page behind it is inert and Tab stays inside, in three browsers;
- [ ] initial focus, Escape and return of focus behave as §20.1 says, and the backdrop closes nothing;
- [ ] an alert dialog puts focus on its safe action and names the act it confirms;
- [ ] a retry keeps its key and its version; an unknown outcome keeps the dialog, locks the form and offers the record.

### Pre-sign-in screens (S0.43)
- [ ] no navigation, user menu, sign-out or session data in any state, and no request for a session;
- [ ] the password step has one refusal, no locked state and no wording that is true of one address and not another;
- [ ] a grant is read once from the fragment, removed from the address by replacing the entry, held in memory only and sent in the body alone;
- [ ] opening a link redeems nothing, and one page answers a link that cannot be used;
- [ ] the QR code and the key are shown together, once, as no link, no copy button and no submitted field, and are gone on leaving, finishing, hiding and timing out;
- [ ] a secret that is handed from one screen to the next is never in the address, the history state or a storage;
- [ ] the keyboard, 320px, 200% text and axe (WCAG 2.2) hold in each state in three engines.

### Signed-in identity screens (S0.44)
- [ ] a list opens on what the person came for, and tells *none* from *filtered to nothing*; a count is never shown while loading;
- [ ] an act sends the version the page read, a profile is read once, and a moved record is explained and read again;
- [ ] only the acts the status and the held keys allow are offered, and a hint is never taken for authority;
- [ ] no field, import or name on a screen that acts on another principal's credential could show one, and each screen's tests plant one;
- [ ] a profile outside the session's hubs and one that does not exist are pages of their own;
- [ ] focus lands on the new page's heading, on the news of an act, and on the way out of an outcome nobody knows;
- [ ] times are 24-hour in Accra with no label whatever the machine's zone, and no id is shown where a name was owed.

### Error / Not Found
- [ ] calm precise copy;
- [ ] safe recovery action;
- [ ] no internal error leakage;
- [ ] the API's diagnostic `message` is never rendered.

---

## 37. Planned kit and deferred pattern register

### The planned kit (PROPOSED)

**Product Owner, 5 November 2026.** The Ops Portal redesign needs the components below. Each is **PROPOSED** (§2): none is built. They are built in redesign step R5, composed in `components/ui` from the shadcn/ui primitives that step R3 installed ([DESIGN_SYSTEM §29.2](DESIGN_SYSTEM.md#292-the-component-foundation)), each to §3 and to [DESIGN_SYSTEM §28](DESIGN_SYSTEM.md#28-component-implementation-rules). A component becomes IMPLEMENTING with its first code, and ACTIVE once a screen uses it and the Product Owner has accepted it. The list is [DESIGN_SYSTEM §27](DESIGN_SYSTEM.md#27-initial-implementation-scope)'s.

| Pattern | What it is for |
|---|---|
| AppShell v2 | the signed-in frame: the sidebar of seven groups with counts, and the top bar ([surfaces/ops-portal.md §4](../surfaces/ops-portal.md#4-navigation-model)) |
| CommandPalette and global search | opening any record by its code, a name or a phone number (Ctrl/Cmd K) |
| NewMenu | every create action, gathered in one menu |
| AccountMenu | personal settings (profile and hubs, trusted browsers) and sign-out |
| HubSwitcher | the hub a person browses, and acts in |
| Tabs with counts | the views of a queue ([PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace)) |
| FilterBar with chips | a queue's filters, each applied choice a chip that can be removed |
| DataTable | the queue table, with selection, a bulk-action bar and an inline row action: TanStack Table, which redesign step R3 adopted, over the table primitive ([DESIGN_SYSTEM §23](DESIGN_SYSTEM.md#23-tables-and-dense-operational-data)). It builds on Table and QueueTable (§19, §22f) |
| SidePanel and Sheet | a record beside its list, and a full-screen sheet at 768px |
| RecordHeader with StageTracker | the record's code, status, stage tracker, primary action and "more actions" menu ([PRODUCT_DESIGN_DIRECTION §6.2](PRODUCT_DESIGN_DIRECTION.md#62-record)) |
| ActionMenu | the overflow menu of a record's acts, destructive acts last |
| DescriptionList | the facts of a record, grouped and labeled |
| Panel and Card | the surfaces of the record template |
| Toast | success after a task, with "Open" and "Do another" |
| Tooltip, Popover | the name of an icon, and the longer explanation behind an info control |
| StatTile | a figure the server states |
| CountBadge | a count in a menu or a tab, **built early, by task C1** (5 November 2026), because the queue summary is the first count the server states: `components/ui/count-badge/`, from the Badge primitive and the tokens, drawn beside the menu's entries and on the landing's list. It is **IMPLEMENTING** (§2): the redesign's own screens (R4) take it from here. It draws a whole number it is given, never capped (a capped figure hides the size of a queue), with the words of what it counts for a screen reader, a count of `0` that was read quietly, and **nothing at all for a count that was not given**: a count that is loading, missing or failed is never drawn as `0` (§24, §25). On the side menu it takes the shell's own tokens, white on the pressed ground, turned round on the filled current entry, and at the corner of the icon on the rail |
| EmptyState v2, Skeleton v2 | the empty and loading treatments, redrawn: a deliberate replacement of §16 and §17, which stay ACTIVE until their screens migrate (§2) |

A count or a figure on these components is the server's: the component draws what it is given and works nothing out (§24, §25).

### The primitives of redesign step R3 (no Melarc component yet)

Step R3 (5 November 2026) installed 24 shadcn/ui primitives in `apps/ops-web/src/components/primitives/` ([DESIGN_SYSTEM §29.2](DESIGN_SYSTEM.md#292-the-component-foundation)): alert dialog, avatar, badge, breadcrumb, button, calendar, card, checkbox, command, dialog, dropdown menu, input, label, popover, scroll area, select, separator, sheet, skeleton, sonner (the toaster), table, tabs, textarea and tooltip. They are **not Melarc components**: no page imports one, and none is a pattern of this file until a component of `components/ui` composes it, a screen uses that component and the Product Owner accepts it (§2). Each is drawn in the showcase (§27), in both themes, with its overlays driven from the keyboard in a real browser. The components of the kit above are composed from them in step R5. The native components that are ACTIVE (Button, Input, Textarea, Checkbox, Select, Table, Dialog, AlertDialog, Skeleton and StatusBadge) are not replaced by their primitives now: an active pattern is not silently replaced (§2), and whether step R5 recomposes any of them is decided there and recorded here.

### Phasing out React Aria Components

**Product Owner, 5 November 2026 (redesign step R3).** React Aria Components was the library for behaviour that no native element gives ([DESIGN_SYSTEM §24a](DESIGN_SYSTEM.md#24a-interaction-primitives)); the shadcn/ui primitives replace it for new components. **Nothing is removed now.** The library, its packages and their licences stay, and so do the `react-aria-pressable-style` meta of `index.html` and the rule of `base.css` that stand in for the style the library inserts, until the last component built on it has moved. The table is derived from the code: apart from tests, the files of `apps/ops-web/src/components/ui/` that import `react-aria-components`, `react-aria`, `react-stately` or `@internationalized/*` are `date-picker/DatePicker.tsx` and `date-picker/date-value.ts`, and no others. The steps are those of [the plan](../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign): R3 adopted the foundation, R5 builds the kit, and R7 moves the screens onto it.

| Melarc component today | React Aria parts it is built on | Replaced by | Step that moves it |
|---|---|---|---|
| DatePicker (§22a): the calendar that opens under the field | `Calendar`, `CalendarGrid`, `CalendarCell`, `Heading`, `Popover`, `Dialog` and `Button` (`date-picker/DatePicker.tsx`) | the `calendar` primitive (react-day-picker, which already starts the week on Monday in English as written in the United Kingdom) in a `popover`, with `button` | R5, with the kit (**proposed**: the plan names no step for it) |
| DatePicker (§22a): the typed day, month and year | `DateInput`, `DateSegment`, `Group` and `I18nProvider` (`date-picker/DatePicker.tsx`); `@internationalized/date` (`date-picker/date-value.ts`) | **none**: the registry has no entry of a date as three typed parts | **open**: R5 puts it to the Product Owner, because it decides whether the library stays for this part |

No other component of `components/ui` is built on the library. What leaves with the last one, and not before: the packages `react-aria-components`, `react-aria`, `react-stately` and `@internationalized/date` and what they bring; their door (the React Aria lines of `eslint.config.mjs` and `test/aria-door.test.ts`); `test/aria-licences.test.ts` and the three licence files only they need (`React-Aria-Apache-2.0.txt`, `swc-helpers-Apache-2.0.txt` and `use-sync-external-store-MIT.txt`; `clsx-MIT.txt` and `aria-hidden-MIT.txt` are the shadcn/ui set's too, and stay); the `react-aria-pressable-style` meta of `index.html`, its rule in `base.css` and `src/components/ui/aria-wiring.test.tsx`.

### The deferred register

This is not a backlog commitment.

It records patterns intentionally **not** built and not in the planned kit:

| Pattern | Introduce when |
|---|---|
| Time of day, a range of dates | the first requirement for either (a single date is section 22a) |
| QrCode (one-time credential display) | the rider device-enrolment screen: a small, reviewed, exactly pinned encoder drawing inline SVG under the content-security policy (no data URI), shown from memory only and cleared on navigation, expiry and completion, never rendered as text; proven by decoding the rendered output with an independent test-only decoder (`SECURITY_DESIGN.md` §13.6, `surfaces/ops-portal.md`) |
| Hand-built advanced grid behavior | not planned: `DataTable` above is the grid, built from TanStack Table, which redesign step R3 adopted (DESIGN_SYSTEM §23) |

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

**Page templates.** The Product Owner has approved design direction for four page templates (queue workspace, record, task form, builder) in
[PRODUCT_DESIGN_DIRECTION.md §6](PRODUCT_DESIGN_DIRECTION.md#6-the-four-page-templates), built in redesign steps R6 and R7. None is a pattern of this
file until it is built (DESIGN_SYSTEM §35), and the screens built so far are not claimed to follow it.

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
| Button | ACTIVE | Yes |
| Link | ACTIVE | Yes |
| Field | ACTIVE | Yes |
| Input | ACTIVE | Yes |
| PasswordInput | ACTIVE | Identity implementation (S0.39a) |
| CodeInput | ACTIVE | Identity implementation (S0.39a) |
| OneTimeSecret, QrCode | ACTIVE | Identity implementation (S0.39b, S0.39c) |
| Alert | ACTIVE | Yes |
| LoadingIndicator | ACTIVE | Yes |
| PageHeader | ACTIVE | Yes |
| NeutralFrame (`AppFrame`) | ACTIVE | Yes |
| AuthenticatedOpsShell, SideMenu | ACTIVE | Identity implementation (S0.42; a side menu since 25 October 2026) |
| Icon, IconButton | ACTIVE | 25 October 2026 |
| DatePicker | IMPLEMENTING | 28 October 2026: built, proven in the showcase and reviewed ([the plan's §7.50](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026)); the pickup screens use it since S1.19 (29 October 2026), and its look awaits the Product Owner |
| RadioGroup, Picker, MoneyAmount, Timeline, QueueTable | IMPLEMENTING | Pickup intake (S1.19, 29 October 2026): built, in the showcase, used by the pickup screens (§22b to §22f) |
| QueueTable row selection, ReorderList, RiderPicker | IMPLEMENTING | Manifests and runs (S1.25, 3 November 2026): built, in the showcase (the rider picker as the Picker over demo riders), used by the manifest screens (§22f, §22g, §22h) |
| Split screen (`AuthSplitLayout`, `AuthArt`) | ACTIVE | 25 October 2026 |
| ErrorState | ACTIVE | Yes |
| NotFoundState | ACTIVE | Yes |
| CountBadge | IMPLEMENTING | Task C1 (5 November 2026): built, used by the menu and the landing's list, proven in jsdom and in a browser in both themes. ACTIVE once the Product Owner accepts C1 and a redesigned screen (R4) uses it (§2) |
| ForbiddenState, EmptyState, Skeleton, StatusBadge, Table | ACTIVE | Identity implementation (S0.40) |
| Select, Dialog, AlertDialog, reason and confirmation | ACTIVE | Identity implementation (S0.41) |
| Button `danger` | ACTIVE | Identity implementation (S0.41) |
| FormPage, the five pre-sign-in screens | ACTIVE | Identity implementation (S0.43) |
| ButtonLink, ConfirmationDialog, the six signed-in identity screens | ACTIVE | Identity implementation (S0.44) |
| The shadcn/ui primitives of `components/primitives` (24, §37) | IMPLEMENTING | Redesign step R3 (5 November 2026): installed and restyled, drawn in the showcase and driven from the keyboard in a browser. No Melarc component or screen uses one yet, and the Product Owner has not yet accepted them |
| The planned kit of §37 (AppShell v2, DataTable, Toast and the rest) | PROPOSED | No: built in redesign step R5 |

---

## 41. Next implementation step

Done. The Product Owner approved `BRAND_FOUNDATION.md`, `DESIGN_SYSTEM.md` and this document (6 October 2026), the small UI
foundation gate was built to them (§42.3), and the tokens, the initial patterns and a development-only showcase exist and
are tested. The next UI work is the identity slice's screens, which add a variant, a size or a pattern only when they first
use it (§30, §37).

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
| Tokens | `styles/tokens.css` | The one token source (DESIGN_SYSTEM §29.1), held to the document by `scripts/design-tokens.test.ts`. The light theme is `:root` and the dark theme is applied by the system setting and by `data-theme="dark"` (DESIGN_SYSTEM §31, step R2). It adds the component token `--button-pressed-background` (the pressed fill of the Secondary and Danger recipes, a value for each theme), the fallback stacks of the two typefaces, the icon sizes and the layout widths the frame already had |
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

### 42.4 What the identity slice's foundation added (S0.38 and S0.39, 23 October 2026)

Paths are under `apps/ops-web/src/`. Each interactive component has keyboard tests in jsdom and a browser pass in the
showcase (`test/browser/components.spec.ts`, `secrets.spec.ts`) in the engines `test:browser` runs.

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| NeutralFrame, logo | `app/AppFrame.tsx`, `assets/brand/` | The banner shows the primary logo (an `img` named "Melarc Logistics", the only thing that says "Melarc") and the text "Ops Portal". It is identification and never a link. Height is `--space-10`, width follows, and the padding is the clear space of BRAND_FOUNDATION §4.5. After a navigation, focus goes to the page's heading, and if the page is not there yet (a guard is asking who is signed in) it waits on the content and moves to the heading when it arrives, unless the person has moved on |
| Form submission | `components/ui/form/use-submission.ts` (a hook, not a component) | The browser's submit and validation are off; one submit at a time (a flag, not the screen's state); `aria-busy` on the form and `loading` on the button; focus on the first `[aria-invalid="true"]` after the errors are committed, each failed submit; the work returns `accepted`, `invalid` or `failed`; an error the work throws is reported with `reportError`, never swallowed |
| PasswordInput | `components/ui/password-input/` | `autoComplete` is required (`current-password` or `new-password`). The value is never trimmed, truncated or changed; paste is allowed. "Show password" is a secondary button whose name swaps ("Hide password"), announced in a polite status, and the password is hidden again when the form is submitted |
| CodeInput | `components/ui/code-input/` | Numeric keyboard, `autocomplete="one-time-code"`; keeps digits only and at most `length` (6). The change handler hears the cleaned value. A text field on purpose: a code is used once and seeing it catches a slip |
| OneTimeSecret | `components/ui/one-time-secret/` | A read-only field in a Field, grouped in fours. No `name` (a form around it never submits it), `autocomplete="off"`, no copy button (clipboard history keeps what is copied), no link. The owner holds the secret with `useTransientSecret` (`platform/secrets/`): gone at completion, expiry (at most 15 minutes), navigation and `pagehide` |
| QrCode | `components/ui/qr-code/` | An inline SVG computed from the matrix of `uqr` (behind `qr-matrix.ts` alone): no remote service, canvas or image file, nothing a strict CSP refuses. Error correction `M`, a four-module quiet zone, four CSS pixels to a module (the picture shrinks proportionally, and only, when its container is narrower than it: at 320 px the largest code, version 12, is drawn a little under four; the browser test asserts four (its one-pixel border included) where there is room and at least three at 320 px for the demo payload, and no floor below three is claimed), up to version 12. Black on white even under forced colours. The payload is in no attribute, title or text; a payload that cannot be drawn throws a `QrCodeError` that does not contain it. Verified by decoding what is drawn with an independent library (`jsqr`, test-only) in jsdom and, from a screenshot, in each engine |
| Session guards | `platform/session/` | `RequireSession` (loading, sign-in redirect that replaces the entry, or an error with an explicit retry) and `RequirePermission` (a refusal that names the permission key, never a role). The full ForbiddenState (§15) is S0.40's |

### 42.5 What the identity slice's read states, dialogs and shell added (S0.40 to S0.42, 24 October 2026)

Paths are under `apps/ops-web/src/`. Each component has jsdom tests (keyboard, accessible name, axe) and a browser pass in the
showcase in three engines.

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| ForbiddenState, ForbiddenPage | `components/ui/forbidden-state/` | Five kinds (§15.2). `RequirePermission` renders `ForbiddenPage`, so the refusal of a guarded route is this pattern, with the title and heading it always had |
| EmptyState | `components/ui/empty-state/` | `none` (success tone) or `filtered` (neutral, with an action the type requires) |
| Skeleton | `components/ui/skeleton/` | Decoration beside a loading indicator, 1 to 20 lines, still under reduced motion |
| StatusBadge | `components/ui/status-badge/` | A tone and words from a `StatusMap` typed over the whole enum; an unknown value is "Unknown status" |
| CountBadge | `components/ui/count-badge/` | A whole number the server counted, from the Badge primitive and the tokens (the first Melarc component to import a primitive); `meaning` is said after the number to a screen reader and hides the drawn digits from it; a read `0` is quiet; `surface="shell"` for the dark menu. What it is drawn beside, and its words, are `app/navigation/queue-places.ts` |
| Table | `components/ui/table/` | A native table in a named, focusable, scrolling region; the screen sorts and the table says the order |
| ReadState, the problem copy | `components/ui/read-state/`, `platform/problem/` | §33.3 |
| Select | `components/ui/select/` | §7.9 |
| Button `danger` | `components/ui/button/` | The outline recipe, §4.7 |
| Dialog, AlertDialog, DialogActions | `components/ui/dialog/` | The native `<dialog>`, §20.1; jsdom is given a small stand-in in `test/setup-components.ts` |
| ReasonSelect, ReasonConfirmationDialog | `components/ui/reason-select/`, `reason-confirmation/` | §20.3, over `platform/reasons/` and `platform/api/use-confirmed-command.ts` |
| AuthenticatedOpsShell, the route registry | `app/AuthenticatedOpsShell.tsx`, `app/navigation/route-registry.tsx` | §12.6. Built as a band across the top (`ShellBar`); replaced on 25 October 2026 by the side menu (§42.8) |

### 42.6 What the identity slice's pre-sign-in screens added (S0.43, 24 October 2026)

Paths are under `apps/ops-web/src/`. Each screen has jsdom tests for its states and for the nine interface states, a sentinel test of the
secrets it handles, and a browser pass in three engines against the production build and the development server
(`test/browser/pre-sign-in.spec.ts`).

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| The five screens | `app/pages/pre-sign-in/` (`SignInPage`, `SignInMfaPage`, `SetupCredentialPage`, `SetupMfaPage`, `SetupMfaCompletePage`), routes in `pre-sign-in-routes.tsx` | §12.7. Siblings of the session guard in the neutral frame. `/recovery` and `/recovery/complete` are the recovery slice's |
| FormPage | `components/FormPage.tsx`, `form-page.css` | The form measure of DESIGN_SYSTEM §13.3 (40rem) and the wrapping row of a form's buttons |
| The grant of a link | `platform/auth/grant-fragment.ts`, `use-grant-token.ts`, `app/pages/pre-sign-in/NoReferrer.tsx`, `GrantProblem.tsx` | `tokenFromHash` reads exactly one `token` made of the characters a link carries; `useGrantToken` reads it once, replaces the entry, and holds it as a transient secret scoped to the page's path |
| What two screens hand each other | `app/pages/pre-sign-in/PreSignInFlowLayout.tsx`, `pre-sign-in-flow.ts` | Two transient secrets in a layout route, scoped to the family of addresses (`familyOf`): the sign-in challenge and the authenticator's material. `useTransientSecret` gained a `scope` option for this and for the page that rewrites its own address |
| The judgement of the answers | `platform/auth/pre-sign-in-shape.ts` | Like the session's: a challenge, the result of the first password and the begin of a re-enrolment are believed only when they have the shape the contract gives them, and the QR address only when it is a TOTP address that can be drawn. A test reads the contract and holds each list to its schema |
| The password rule | `platform/auth/password-rule.ts` | 12 to 128 code points, as typed and after NFKC; the sign-in has the one bound of 128. A courtesy: the server counts again |
| Copy | `platform/problem/problem-copy.ts` | The five operations' rules, and the context `unknown-outcome` |
| The frame's move of focus | `app/AppFrame.tsx` | Now a layout effect: the heading has focus when the new page is first painted, not a few milliseconds after, which made a field filled at that moment lose its text (found by a flaky WebKit test and pinned by a deterministic one) |
| `emptyField` | `components/ui/form/use-submission.ts` | A password or a code is emptied from the form once the server has answered it |


### 42.7 What the identity slice's signed-in screens added (S0.44, 24 October 2026)

Paths are under `apps/ops-web/src/`. Each screen has jsdom tests for its states and for the nine interface states, a test that plants a
credential in the answer, and a browser pass in three engines against the production build and the development server
(`test/browser/staff.spec.ts`).

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| The six screens | `app/pages/LandingPage.tsx`, `app/pages/staff/` (`StaffListPage`, `StaffCreatePage`, `StaffDetailPage`, `StaffMfaResetPage`, `SessionsPage`), routes in `app/navigation/route-registry.tsx` | §12.8. The registry gained a `description` for the landing's list of places (`destinationsFor`) |
| ButtonLink | `components/ui/button/ButtonLink.tsx` | §4.12. An anchor drawn with the Button recipes |
| ConfirmationDialog | `components/ui/confirmation/ConfirmationDialog.tsx`, with `reason-confirmation/command-outcome.tsx` shared with the reason dialog | §20.4. `ReasonConfirmationDialog` gained `confirmVariant` |
| The profile gate | `app/pages/staff/WithProfile.tsx` | Reads a profile once for the pages about one (the profile, the reset), and shows the two pages of their own for a profile that is not there or is outside the hubs |
| The judgement of the answers | `platform/staff/staff-shape.ts` | Like the session's: a profile, a page of the list, the assignable roles, a session, the outcome of a reset and of a re-issue are believed only when they have the shape the contract gives them, and carry nothing a credential could ride in on. A test reads the contract and holds each list and each enumeration to its schema |
| Reads and commands | `platform/staff/use-staff-queries.ts`, `staff-commands.ts` | Reads are not repeated on focus or on reconnect, are not kept once the screen lets go of them, and a failed one is retried by the person. A command sends `If-Match` as the read gave it, and an `Idempotency-Key` only where the operation declares one |
| Copy | `platform/problem/staff-copy.ts` | Rules for the ten operations, in the one table. Proposed for the Product Owner to review with the composed screens |
| `formatInstant` | `platform/time/format-time.ts` | §40: 24-hour in Accra, no label, a fixed table of months so that no runtime's spelling can change it |
| The session's principal | `platform/session/session-shape.ts` | `principal_id` is carried so that a screen can say "you created this" (a hint; the server decides) |

### 42.8 What the Product Owner's decisions of 25 October 2026 added (the side menu, the icons, the split screen)

Paths are under `apps/ops-web/src/`. Each component has jsdom tests (keyboard, accessible name, axe) and a browser pass in three engines:
the shell and the split screen against the production build, the side menu and its demo in the showcase.

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| Icon, the registry | `components/ui/icon/` (`Icon.tsx`, `icons.ts`) | §24 of the design system. Lucide, imported by `icons.ts` alone (the shadcn/ui primitives apart, §37); every icon is named by its meaning and drawn at one stroke and three sizes; a test fails on an icon nobody uses and on a second door to the library |
| IconButton | `components/ui/icon-button/` | §22. `label` is required; `bare` and `inverse`; `loading`; a `ref` for a caller that moves focus to it |
| SideMenu | `components/side-menu/` | §12.6. Collapses to a rail, slides in on a narrow screen with the main content inert, scrolls as a whole when the window is too short; the collapse state is in memory only |
| PrimaryNavigation | `components/PrimaryNavigation.tsx` | A vertical list of an icon and a label; the current entry is a filled item with `aria-current`; a `title` when the menu is collapsed |
| BrandLockup | `components/brand/` | The symbol (`public/favicon.svg`, served as it is) on a white tile and the name as text, for a surface on Ink: the side menu and the split screen's band |
| Frame layouts | `app/AppFrame.tsx`, `app/frame-chrome.ts` | `neutral`, `sidebar` and `split`, chosen by the route tree (`useFrameLayout`), never by a page; the sidebar layout has no banner, the split layout draws its panel in the place beside the main content |
| AuthSplitLayout, AuthArt | `app/pages/pre-sign-in/AuthSplitLayout.tsx`, `components/auth-art/` | §12.7. Decorative photography, loaded lazily, one table for which photograph goes with which screen (`auth-art.ts`) |
| Favicon | `public/favicon.svg`, `index.html` | The approved symbol, the browser-tab icon and nothing else |


### 42.9 What the Product Owner's decision of 28 October 2026 added (React Aria Components, the date field)

Paths are under `apps/ops-web/src/`. The date field has jsdom tests and a browser pass in three engines in the showcase, and a production
build of the showcase is served under the strict content-security policy (`test/browser/date-picker-policy.spec.ts`).

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| DatePicker | `components/ui/date-picker/` (`DatePicker.tsx`, `date-value.ts`, `date-picker.css`) | §22a. The behaviour is the library's, behind the one door of DESIGN_SYSTEM §24a; the value is the text `YYYY-MM-DD`; the language is fixed (day, month, year, Monday first, English); today is Accra's (`platform/time`). Not built: a range of dates, a time of day |
| The dialog's container | `components/ui/dialog/dialog-container.ts` | The element a modal dialog is, given to what it holds, so that a calendar is drawn into it |

### 42.10 What the Product Owner's decision of 5 November 2026 added (redesign step R3: the shadcn/ui primitives)

Paths are under `apps/ops-web/src/`. The primitives have a scan of the showcase with axe in both themes and every overlay driven from the keyboard in a browser
(`test/browser/primitives.spec.ts`), and a production build of the showcase is served under the strict content-security policy (`primitives-policy.spec.ts`).
No Melarc component is built on them yet (§37).

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| The primitives | `components/primitives/` (24 files) | §37. Generated source from the official shadcn registry, restyled through the tokens, one door to Radix UI and the libraries beside it (DESIGN_SYSTEM §29.2, §29.6 for where they differ from the registry's source) |
| `cn`, `useResolvedTheme` | `lib/utils.ts`, `platform/theme/use-resolved-theme.ts` | The one way class names are joined; the theme that applies (the root's `data-theme`, then the system's setting), for what a library must be told in a prop |
| The showcase of the primitives | `showcase/PrimitivesShowcase.tsx`, `showcase/DataTableDemo.tsx` | §27. Every primitive in both themes, in Melarc's words, and a data table built with TanStack Table (sorting, selection, `aria-sort`) |
| The banner's logo | `app/AppFrame.tsx` | The primary logo on a light ground and the all-white lockup on a dark one, chosen by `useResolvedTheme`: one image that carries the name once (DESIGN_SYSTEM §31) |

---

**End of Melarc Component Patterns v1.1**
