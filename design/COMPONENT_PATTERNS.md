# Melarc Component Patterns

> **Status:** ACTIVE IMPLEMENTATION BASELINE — approved by the Product Owner on 6 October 2026; document only patterns that exist or are immediately being implemented  
> **Version:** 1.2  
> **Date:** 5 October 2026; revised 6 October 2026 to reconcile it with the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md) (§4, §9, §12, §24, §33, §36, §40, §42), and on 5 November 2026 for the planned kit of the Ops Portal redesign (§1, §3, §12.6, §21, §22f, §37, §38, §40), and again that day in redesign step R2 for the heights, the side menu's current item, the Toast's actions, the table's rows and the token file's description (§4, §12.6, §21, §22, §42), and on 6 November 2026 in redesign step R5 for the first half of the component kit, Motion and the date field's new anatomy (§3, §11, §21, §22a, §22g, §27, §37, §40)  
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
    component of `components/ui`, and never from a hand-built widget or a second library (DESIGN_SYSTEM §29.2). React Aria Components has been
    removed (§37).
    TanStack Table (the data model of the queue table) sits behind a component of `components/ui` on the terms of DESIGN_SYSTEM §23;
    Motion (animation) is adopted, behind the one door of `components/ui/motion/`, on the motion tokens and off under reduced motion
    (DESIGN_SYSTEM §24a; §37).

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

**One exception, recorded (task R5.2, M16).** A link that is the whole of a card (the cards of *My work*) is the name of the card's queue stretched over the card, so a press anywhere on the card follows it. It carries a **chevron** in place of the underline, which is its cue, and it is in the primary text colour: the card, not its words, is the link, and the ring of its focus is drawn round the card. Every other link keeps its underline, always.

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

> **Status:** ACTIVE (25 October 2026, for the trusted browser of [staff-authentication.md](../features/identity/staff-authentication.md) §5.8; confirmed as a pattern by the Product Owner on 8 November 2026)
> **Code:** `apps/ops-web/src/components/ui/checkbox/`

One native `<input type="checkbox">` with a real `<label>` beside it, so that the whole phrase is the target, and optional help beneath
the phrase, linked with `aria-describedby`. It is a **choice the person makes and never a state the page decides**: it is off unless
the caller says the choice was already the person's (`defaultChecked`), and a form reads it at submit time (`fieldChecked`), not from a
copy kept in the page. The label states what ticking it means in a short sentence-case phrase (*Remember this browser for 7 days*), and
the help says what the choice does and does not do; neither is a placeholder for the other. It is drawn by the browser (so forced
colours, zoom and assistive technology behave as everywhere), 1.25rem square, tinted with the primary action colour, with the frame's
own focus ring. It takes no part in a Field, which is for a text control; a checkbox that needs an error says it in an Alert of the
form. It has no indeterminate state, no switch look and no group: a list of several choices is another pattern and is not built.

**There is one checkbox for a form, and the table's box is another thing (task R5.2, M12).** This native one is the checkbox of every form (the trusted browser, the pickup form, and the selection of `QueueTable`, §22f). The box of a row of the `DataTable` (§37) is the checkbox primitive, in a label as large as its cell; it is not a form control and no form reads it. A page never imports the primitive. `QueueTable` moves to `DataTable` in step R7, and no page changed in R5.2. **Decided by the Product Owner on 8 November 2026: the form checkbox stays native, and the table's row box stays the primitive.** The two are not merged and the question is closed: a form is drawn by the browser (forced colours, zoom and assistive technology behave as everywhere), and a row's box is a shadcn/ui primitive inside the label the table draws for it.

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

*The redesign's PageHeader* (a count, a freshness line, a breadcrumb and the 24/30 title) is a separate component, `components/ui/page-header/`, built in step R5 (§37, *the kit as built*). This initial one stays ACTIVE, and the screens that import it unchanged, until steps R6 and R7 move them.

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

> **Status:** the neutral frame is ACTIVE (`apps/ops-web/src/app/AppFrame.tsx`); the authenticated Ops shell is IMPLEMENTING (§2: S0.42 built its first form as ACTIVE; the sidebar and the top bar of redesign step R4, built on 7 November 2026 and described in §12.6, replaced it, and the ACTIVE status returns once the Product Owner accepts them); the split screen of the
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

AuthenticatedOpsShell (AppFrame, layout `sidebar`: S0.42; the sidebar and the top bar since redesign step R4)
├── SkipLink                      (the frame's)
├── Sidebar                       the lockup, the entries in groups from the registry (an icon, a label and, where the server counted a queue, a
│                                 count), the person at the foot; the rail below 1280px, a sheet under 768px
├── TopBar                        the banner: HubSwitcher, Search, ThemeMenu, NewMenu, AccountMenu (and, on a narrow screen, the button that opens the sheet)
├── CommandPalette                a dialog, opened by the search and by Ctrl or ⌘ K
└── MainContent                   (the frame's; focus moves to the new page's heading)
```

The pre-sign-in screens, the setup pages included, use the split screen (DESIGN_SYSTEM §13.1a). Exact navigation behavior
depends on the product surface.

### 12.3 Visual direction

Neutral frame: quiet, on `surface.page`, the logo and the product name, no Ink navigation. The split screen of the
pre-sign-in pages (§12.7) is the same frame with photography beside the form: the only Ink on it is the band under the
photograph, which is decoration, and it carries no navigation and no signed-in affordance.

Authenticated Ops shell: an application's frame and not a website's, so its navigation is a menu at the side and not a band
at the top (Product Owner, 25 October 2026), with a top bar over the page (Product Owner, 5 November 2026):

- an Ink sidebar, full height, that is a rail of icons below 1280px and when asked, and a sheet on a narrow screen, and over the page a
  56px top bar for the hub, the search, the theme, the New menu and the account;
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

### 12.6 The authenticated Ops shell as built (S0.42; the sidebar and the top bar since redesign step R4)

> **Code:** `apps/ops-web/src/app/AuthenticatedOpsShell.tsx`, `app/shell/` (`ShellChrome`, `ShellPalette`, `record-line.ts`, `use-palette.ts`, `focus-return.ts`), `app/navigation/` (`route-registry.tsx`, `navigation-model.ts`), `components/ui/app-shell/` (`Sidebar`, `MobileSidebar`, `TopBar`, `SearchButton`, `HubSwitcher`, `NewMenu`, `ThemeMenu`, `AccountMenu`, `CommandPalette`), `platform/hub/`, `platform/theme/`, `components/brand/BrandLockup.tsx`, `app/frame-chrome.ts`

The Ops Portal is an application and not a website, so its navigation is a menu at the side and not a band at the top (Product Owner, 25 October 2026, with a reference screenshot of a dark menu with icons, a red current item and an account card). The approved redesign (Product Owner, 5 and 6 November 2026; [surfaces/ops-portal.md §4](../surfaces/ops-portal.md#4-navigation-model)) gave it a top bar over the page and a sidebar of seven groups; this section records what redesign step R4 built. Each component named in §37 for it (AppShell v2, CommandPalette, NewMenu, AccountMenu, HubSwitcher) is the one of `components/ui/app-shell/`, which presents what it is given and knows nothing of sessions, permissions or routes: `app/shell/` decides what to give it.

- **A layout route between the session guard and the signed-in routes**, and around nothing else: it is drawn only for a session the API has said is there and only for the routes of the registry. The neutral frame is not changed: an address that matches no route uses the frame with no sidebar and no top bar, even for a person who is signed in.
- **The sidebar and the top bar are drawn into the frame's own places** (`useFrameChrome` beside the main content, `useFrameTopBar` over it), and the route tree asks the frame for its sidebar layout (`useFrameLayout`): the frame then draws no banner above the page, and the top bar is the page's banner. The order of the page is skip link, sidebar, top bar, main content, each a landmark of its own (the sidebar an `aside` named "Main menu" holding the `nav` named "Primary"; the top bar the `header`), never inside the main content, and the skip link passes the sidebar and the top bar. The frame's landmarks, skip link and move of focus are the frame's and are not copied.
- **One route registry** (`SIGNED_IN_ROUTES`) is where the signed-in routes and their places in the navigation are written, and the route tree and the navigation are both derived from it: a route cannot exist without a decision about its place (an entry of the sidebar with its group, label, icon, order and, where it has one, the queue whose count it carries; an action of the New menu; a page of the account menu; or `null` for a screen reached from another) and about the key it needs (a permission, or any signed-in session). An entry cannot link a screen that does not exist, because nothing but a route makes one. A later task adds its screens there and nowhere else.
- **The navigation is the entries of the routes whose key the session holds** (`navigationFor`, from `CurrentSession.permissions` and the routes that exist), in the seven groups of the specification (Today, Pickups, Hub, Dispatch, Money, People and access, System), a group only when it has an entry, in the registry's order; an unbuilt route has no entry even when its key is held. A hint never authorises: every route is behind `RequirePermission`, and the server checks every request. No role name or bundle is read anywhere in the navigation or the guards (`test/navigation-no-roles.test.ts`); the navigation tests carry the keys of each seeded bundle written out beside its name, held to the seed by a root test, and a soundness check refuses a registry with an entry that has no label, no icon or an order another entry of its group has.
- **The sidebar** (§4.6, the shell recipe) is Ink in both themes, with a 1px right edge in `shell.border` (a hairline that measures 1.19:1 against the Ink in the light theme, where it is almost the Ink's own colour and hardly shows beside a light page, and 1.24:1 in the dark theme, where the Ink lies beside a canvas of almost the same darkness and the edge is what marks the side of the sidebar), 248px wide (15.5rem) and as tall as the window, and stays where it is while the page scrolls. At its head are the all-white lockup (about 132 by 42, its own file, never redrawn) and the button that collapses it. Then the groups: a group's heading is 11px, weight 600, in capitals, and is the label of the list of its entries (a screen reader says "Today, list, 2 items", and no heading is added to the page's outline); an entry is 36px high with the radius of a control (`radius.md`), a 17px icon of the family and a label of 13.5px in `shell.text.muted`, with `shell.surface.hover` and `shell.text` under the pointer. **The current entry is a solid crimson fill (`shell.active`) with white bold text and `aria-current="page"`**, never marked by colour alone and, under forced colours, a border and the system's highlight. Where the server counted a queue an entry carries a count (`CountBadge`, §37), a pill that is white at 18% on the current entry (at 22% the white text on the crimson measures 4.32:1, and the specification asks for 4.5:1 at that size; at 18% it measures 4.63:1 on the crimson and 5.31:1 on its hover fill, in both themes, which the test "the pill of a count on the current entry of the sidebar" in `scripts/design-tokens.test.ts` holds; the Product Owner accepted 18% in the place of 22% on 6 November 2026); a count that is loading, missing or failed is not drawn. Focus uses the **inverse** recipe (`focus.ringInverse` outside a band of `focus.offsetInverse`), because the default ring is only 2.96:1 on Ink. The foot names the person (the initials as decoration, the name, and where they act: the hub's name, or how many hubs); the session names no role, so none is shown.
- **The rail and the sheet.** From 1280px the sidebar is the full one, and below it the rail, 64px (4rem) wide; the button at its head ("Collapse menu", then "Expand menu", with `aria-expanded`) asks for the other. On the rail every entry keeps its name (the label is drawn out of sight and not removed) and shows it, with what its count counts, in a tooltip on hover and on focus (300 ms; Escape takes it away); the lockup gives way to the symbol on a white tile (`BrandLockup`), a count sits under the icon, inside its entry (the CountBadge at its own 12px size, not scaled; the entry stays 36px high, and on the current entry the pill is wholly on the crimson) and the headings give way to a rule. The choice lasts as long as the page and no longer: nothing is written to web storage, so a reload starts at what the width gives. **Under 768px the sidebar is a sheet**: the Sheet primitive, a modal dialog named "Main menu" that slides in from the left in `motion.slow` and is never wider than 85% of the window, opened by the "Open menu" button at the start of the top bar. Focus goes to "Close menu" and is kept inside; Escape, the scrim, "Close menu" and following an entry close it; while it is open the page behind is hidden from assistive technology; focus goes back to the button, or, after a link, to the new page's heading. A person who asked for reduced motion sees it appear and disappear without the slide. The lockup gives up width when text is enlarged, so the close button stays inside the sheet, and the whole panel scrolls when the window is too short for it. At 320px and at 200% text nothing clips and the page never scrolls sideways.
- **The top bar** is 56px high on the default surface, with the subtle border under it and 24px of padding at the sides (24px from 768px and 16px under it, as the page is padded: one limit, `47.9375rem`, for the bar, the page and the sheet), and the controls in it are the small height (36px). **It stays at the top of the window while the page scrolls** (a sticky item of the frame, over the page and under the menus that open from it) **and the root keeps its height clear as scroll padding** (`scroll-padding-top`, the bar's **measured** height and a little more: the bar wraps into a second row when text is enlarged, and `useTopBarClearance` keeps the measure, audit B2 of 7 November 2026), so that a heading the frame focuses, a control reached by Tab or an in-page link is brought in below it and not under it (WCAG 2.4.11); **the skip link, once focused, is painted above it** (its layer is above the bar's and below the menus'). A browser test scrolls the page, brings a heading in, and asks which element is at the centre and the corners of the focused skip link, at 390, 768 and 1280px. Another tabs backwards up a long list, at 100% and at 200% text, and asks that each control reached is below the bottom edge of the bar. From the start: on a narrow screen the "Open menu" button, then the hub switcher (a 6px crimson square and the hub's name; for a session with more than one hub a menu of "Show work for", *All hubs* and each hub, kept in memory by `platform/hub` and read by `useActiveHub`; for one hub the name alone), then the search. At the end: the theme control (an icon button named "Theme: System", "Theme: Light" or "Theme: Dark" with a menu of the three, left out of the bar on a narrow screen, where the account menu has the same choice), the New menu (the crimson `brand` Button, "New", with a plus; its items are links to the pages that create, offered only for the keys the session holds, and none for a session that may create nothing) and the account menu (an avatar button named "Account menu").
- **The search is a button that looks like a field** and says "Search a code, name or phone" with the key hint (`Ctrl K`, `⌘K` on an Apple platform; read to assistive technology as `aria-keyshortcuts`, not as part of the name). It is not a field because a dialog that opens when a control merely takes focus changes the context on focus (WCAG 3.2.1, level A), and a person tabbing across the top bar would open it by passing (the Product Owner accepted a button in the place of a field that opens on focus, 6 November 2026); a click, Enter or Space opens the palette, as does Ctrl or ⌘ K from anywhere in the shell, on every platform (it closes it again; a key held down toggles nothing; and it does nothing, and leaves the browser's own use of the key alone, while a native modal dialog of the page is open). **Where the bar gives the search less than about 18.5rem** (a narrow screen, the sidebar open beside the bar at a tablet's width, text enlarged to 200%) **only the icon is drawn and the words stay in the name**: words cut short would be clipped text (WCAG 1.4.4 and 1.4.10), and a search with no room for its icon wraps to a row of its own. The question is asked of the search's own place (a container query, in `rem`), not of the window.
- **A phone number is masked in the results of a lookup and whole on the record's own page** (task R5.2, M16). The search and the palette show `+233******111`: a result is a pointer to a record, and a list of masked numbers is safe to show over a shoulder. A record's own page (the facts of a record, the panel of a record) shows the number the record's own read returned, whole, because the person who opened the record may need to read it to a sender on a call. The server decides what a read returns; the page never unmasks a number it was not given.
- **The command palette** (the `command` primitive in a dialog named "Search") has three groups in this order: *Go to* (the built pages the session may open), *Create* (the New menu's actions) and *Records* (`lookupRecords`, §37). The first two are narrowed by what is typed, by the name of a page or by what it is for; **the records are the server's answer to the text and are never filtered again** (a record found by a phone number does not contain the number). The search asks only while the palette is open and the text is two to 64 characters (once trimmed and its white space folded, as the server reads it), once the text has stood still, and **never again by itself**: each state is told in plain words under the list (a hint, "Searching…", "No record matches “…”", "Use 64 characters or fewer to search records." for a longer text, and a failure in the words of the portal's table with *Try again*), in **one polite live region that stays in the document through every state** and says how many records were found when there are results (the failure is an alert of its own), and the text is forgotten when it closes. **The line under a record is the portal's own** (`record-line.ts`): the sender, the state in the words the same state has on its page, the hub, the day, and a phone number only as the server masked it, on the record that number found; a state the portal has no words for is left out and never drawn as it came. A record opens by the portal's own page for its kind and id (`recordRoute`), and no link, wording or number of the answer is used. Arrows move, Enter opens, Escape closes.
- **Focus goes where the person is.** A dialog that has no trigger of its own (the palette, the sheet) gives focus back to whatever had it when it opened, or to its button, and a menu or a dialog that was used to go somewhere leaves it on the new page's heading, where the frame put it (`app/shell/focus-return.ts`): Radix gives focus back to a trigger and to nothing else, and would otherwise take it from the heading of the page that opened.
- **The theme** is chosen in the theme control and in the account menu, and is the one thing the portal keeps in the browser: `localStorage`, the key `melarc-theme`, written for Light and Dark and removed for System (the default, which follows the computer), read, written and removed in one module (`platform/theme/theme-choice.ts`, the only module that touches web storage and the one exception to the rule that application code does not) and applied as `data-theme` on the root. A script of the page's own origin (`public/theme-init.js`, a classic script in the head and the one other file that touches the storage: it only reads the key) applies the stored choice before the first paint, because a module script is deferred and the policy refuses an inline one; `test/theme-init.test.ts` holds it to the module's key. The other tab of the same browser follows a change: the listener of the `storage` event is registered once, when the application starts (`startThemeChoice`), and not by each control that shows the choice, so every page follows it, with or without a theme control on the screen.
- **The account menu** says who is signed in and where they act, offers the personal pages (Trusted browsers), the theme (System, Light, Dark) and **Sign out**. A page called "Profile and hubs" is not offered: no such page exists, and a page that is not built has no entry.
- **Sign-out** is the last item of the account menu, on every signed-in screen. It calls `signOut` and ends the session by the one action that ends it (the same event that an answer of `SESSION_INVALID` raises), so the cache, the person and the screen go the way they always do. The menu stays open on "Signing out…" while it is under way, and a second selection does nothing. `204` and `SESSION_INVALID` are **done**; anything else (no connection, a fault, `CSRF_VALIDATION_FAILED`) leaves the person signed in with "Sign-out did not finish, so you are still signed in." at the top of the page and **Try again**, which is safe because the act is idempotent, and the menu is closed when the failure arrives; "signed out" is never said while the session may be live. An answer for a session that was replaced meanwhile is dropped.
- **The counts** come from `getQueueSummary` and are read when the shell loads, when the person goes to another page, when they ask for a refresh of a queue, when they choose another hub and after an act that changes a queue (`platform/queue-summary/queue-changing-acts.ts`: one list of the acts, held to the contract by a test; one wrapper of the API client tells of an act answered `ok`, and one function reads the summary again, replacing a read still on its way), never on a timer.
- **Who is signed in** is told by the foot of the sidebar, the account menu and My work, each in its own words; a session with no display name is "Signed in" in the foot and the menu and "You are signed in." on My work.

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

> **Code:** `apps/ops-web/src/app/pages/staff/`, `platform/staff/`. (The signed-in landing is My work, `app/pages/my-work/`, §12.6.)

- **Six screens behind the registry** (`SIGNED_IN_ROUTES`): `/` (the landing; My work since redesign step R4), `/admin/staff` (the list and the approver's queue),
  `/admin/staff/new`, `/admin/staff/{id}`, `/admin/staff/{id}/mfa/reset` and `/admin/sessions`. Each names the permission key its guard needs
  and, for the first three and the sessions page, a menu entry (the sidebar's since redesign step R4; S0.44's landing listed them with a line of what each is for). The detail and the
  reset are reached from a profile, so they have none. A profile also leads to the sessions page with the person chosen; opened from the menu
  it asks for one.
- **The list opens on what the person came for**: the queue for a session that can approve, everyone for one that cannot. The view and the
  search are in the address, so a link (the card of the staff profiles waiting for approval on My work, which S0.44's "Review the queue" became) and Back mean what they say; the page of results is not, because a
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

| Kind | Meaning | Says |
|---|---|---|
| `permission-missing` | The session does not hold the permission the page or part needs (`PERMISSION_DENIED`) | what the account cannot do, in the plain words of the permission: *Your account can’t see pickup requests. Ask an administrator for access.* |
| `insufficient-authority` | It holds the key, and this target or state needs a higher authority (`INSUFFICIENT_AUTHORITY`) | that a higher authority is needed |
| `outside-hubs` | The record exists in a hub the session does not act in (`HUB_SCOPE_VIOLATION`) | that the record belongs to a hub the session does not act in |
| `approval-required` | A different approver decides this (`SELF_APPROVAL_FORBIDDEN`) | that a different approver decides |
| `unavailable-here` | The act is not available for this record as it stands | that it cannot be done as the record stands |

### 15.3 Rules

- It says **what the account cannot do, in plain words**, and never draws the permission key or a role ([PRODUCT_DESIGN_DIRECTION §6.5](PRODUCT_DESIGN_DIRECTION.md#65-on-screen-language),
  the Product Owner’s decision of 5 November 2026; [surfaces/ops-portal.md](../surfaces/ops-portal.md) §7). The words of every permission are one table,
  `platform/problem/capability-words.ts`, and a test holds it to the catalogue and to the keys the portal names: a key a screen names has its words, and a word is not kept
  for a key no screen names. A refusal for a missing permission is still given the key (the words are looked up by it, and the type requires it), but never draws it; a key with no
  words is told as *do this*, never as the key.
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
- **EmptyState v2** (§37, *EmptyState v2*; redesign step R5, second half) is this pattern redrawn: a 10px crimson square, a title, one
  line and an optional action, in three variants (`empty`, `filtered-empty`, `all-clear`). It is IMPLEMENTING and a separate component;
  **this one stays ACTIVE**, and is what the pages draw, until their screens migrate (§2).

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

**Skeleton v2 and LoadingRow** (§37, *Skeleton v2*; redesign step R5, second half) redraw it in the shapes of a table row and of a
card. They are IMPLEMENTING and separate components; **this one stays ACTIVE**, and is what the pages draw, until their screens
migrate (§2).

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
- **The badge is never wider than its room** (task R5.2, M9): its words wrap when they must (a long status at 200% text on a 320px screen was 339px wide in a 126px box and scrolled the page sideways). In a table the row is one line and the box scrolls, so a badge there stays on one line.
- A value the mapping does not have (a newer server, a mapping not yet updated) is shown **neutral as "Unknown status"**, never as
  the raw value and never in a colour that means something. The lookup finds own properties only, so `constructor` and
  `__proto__` are unknown values like any other.
- **StatusBadge v2** (redesign step R5, second half; §37, *StatusBadge v2*) is this component redrawn in place: five pairs (`waiting`,
  `success`, `info`, `neutral`, `danger`) and a 6px dot before the words, with `warning` still accepted as the old name of `waiting`,
  so that no mapping changed. Every state of the application is in **one table** (§37), in code and there. The rules above stand;
  the look is IMPLEMENTING until the Product Owner accepts it (§2).

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
| Scrim | `--color-surface-inverse` at 55% by `opacity` on `::backdrop`: no new colour, and no token to add. It fades in with the panel. |
| Surface and elevation | `surface.default` with the strong border, `radius.lg` (12px) corners and the one soft shadow of a thing that floats, `shadow.floating` ([DESIGN_SYSTEM §8](DESIGN_SYSTEM.md#8-elevation)): the recipe of the `dialog` primitive's panel. |
| Motion | In over `motion.normal` on `motion.easeEnter`, fading and growing from 95% ([DESIGN_SYSTEM §9](DESIGN_SYSTEM.md#9-motion)); nothing animates under reduced motion (the animation is switched off, not only given no time). **No exit**: the platform closes a native dialog at once (§37, *Dialog and AlertDialog: reused, with the Melarc defaults*). |
| Size | `min(32rem, 100vw - 2 × space.4)`; it scrolls inside itself, so enlarged text and 320px never push it off the screen. |

jsdom has no `showModal()`, `close()` or `returnValue`, so `test/setup-components.ts` supplies enough of them for a component test
to drive a dialog (open state, the `cancel` on Escape, the queued `close`, initial focus). **What jsdom cannot show is proved in a
real browser, in three engines** (`test/browser/dialogs.spec.ts`): that the page behind is inert, that Tab stays inside, the
scrim, and the return of focus.

### 20.2 AlertDialog

For a question that interrupts: a high-risk confirmation, and never for information. A title that is a question, the consequence in
words (the dialog is described by it), a dismiss button (**Cancel** by default; **Go back** where the act is itself a cancellation, for a dismiss never repeats the verb of the act it dismisses; focused first) and a confirming button that **says what it does** ("Reset the
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

> **Status:** IMPLEMENTING (redesign step R5, first half, 6 November 2026; the component is described in §37, *the kit as built*; its two actions and the one toaster of the signed-in frame are the follow-up of 7 November 2026, afternoon; ACTIVE when a screen uses it and the Product Owner accepts it)  
> **Code:** `apps/ops-web/src/components/ui/toast/`

The Product Owner decided one workflow on 5 November 2026: the success of a task lands as a toast ([PRODUCT_DESIGN_DIRECTION §6.3](PRODUCT_DESIGN_DIRECTION.md#63-task-form)). **A toast that carries an action does not time out** (approved the same day, so that a person has the time to use the action, WCAG 2.2.1): it stays until the action is taken or it is dismissed. The three things this section had to establish before the toast was built are settled by the component:

- **Which messages are transient.** A toast with no action goes after six seconds: it acknowledges what the page already shows.
- **Which must remain.** A toast with an action stays until dismissed. **Important business outcomes never exist only in a disappearing toast:** the state reached is also the page's own (a changed row, a state told on the page), and the toast is the acknowledgement, never the record.
- **Live-region behaviour.** The toaster is a polite live region that the keyboard can reach (Alt+T); a toast appears without taking focus; its action and its dismiss control are real buttons; the message is read once (the tone's icon is decoration); its motion stops under reduced motion.

**Up to two actions, a primary and a secondary** (the Product Owner's answer of 7 November 2026, afternoon, which settles the conflict of the brief of 6 November, one action, with the task form's success of [PRODUCT_DESIGN_DIRECTION §6.3](PRODUCT_DESIGN_DIRECTION.md#63-task-form), "Open" and "Do another"). The **primary action** says **"Open"** where the act made something to open, or **"Undo"** only where the server allows that act to be undone (no operation of the contract does yet, so no screen may offer it); the type allows no other word there. The **secondary action** is the next thing to do, **in the screen's own words** ("Book another"); it is never "Undo" (a toast that offers it is refused), and **a secondary action without a primary one is impossible**: the type has no such shape, and a caller that gets round the type is refused at run time. **A toast with any action stays until it is dismissed**, and using either action takes it away. The actions stand under the message (two of them do not fit beside it in a toast of 356px), the primary one first in the link colours and the secondary one quieter, and both are real buttons in the Tab order: the primary action, the secondary one, then the dismiss control.

**The toaster is mounted once, in the signed-in frame** (`AuthenticatedOpsShell`, bottom right; Sonner takes its animations away under reduced motion), and a screen never mounts one. **It is drawn into the body of the page, outside every landmark**: a sheet or a dialog that hides the page from assistive technology (Radix UI hides what is beside what it opens) leaves a live region alone and every element that holds it, so a toaster inside the main landmark kept the whole of *main* exposed behind an open sheet, which `shell.spec.ts` found. A toast raised while a native modal dialog is open is drawn behind its scrim, because the modal makes everything outside it inert, and can be reached once the dialog has closed. The showcase's pages are outside the shell and mount their own. A second `<Toaster />` mounted anywhere draws nothing, because Sonner keeps one store for the whole page and every toaster it draws shows every toast: only the first one mounted draws, and the next takes over when it goes. `shell.spec.ts` shows the one toaster of the production build under the strict policy, and `frame-toaster.spec.ts` raises a toast in the frame, in a browser, through the module that the application itself runs (no hook is put into the production build for it).

---

## 22. Icon Button

> **Status:** ACTIVE (25 October 2026: the eye of the password field; the controls of the sidebar and the top bar since redesign step R4)

A native `<button>` named by a required `label` and drawn with one icon of the family (DESIGN_SYSTEM §24; the registry is
`components/ui/icon/icons.ts`). It is the only way to make an icon-only control (`components/ui/icon-button/`).

- icon-only controls require accessible names: `label` is required and is the accessible name, and it names the act ("Show password",
  "Collapse menu", "Sign out"), not the picture;
- a tooltip may improve discoverability but does not replace the accessible label: the `title` repeats the name for a pointer user, and
  the icon button draws no tooltip of its own, because one that appears on hover or focus must be dismissible, hoverable and persistent
  (WCAG 1.4.13). The kit's `Tooltip` (§37, *Tooltip*) is that kind, for the hint a screen adds, and never for the name;
- target size stays usable: at least 2rem square, above the 24px of WCAG 2.2, and it grows with enlarged text;
- icon meaning must be conventional or otherwise clear: an eye to show, a menu, a cross to close, chevrons to collapse and expand, an
  arrow out of a door to sign out; the same meaning has the same picture everywhere;
- `bare` on a light surface and `inverse` on Ink, where the focus ring is the inverse recipe; `loading` keeps the name and the place,
  ignores activation and shows a spinner (`aria-busy`, `aria-disabled`, and not the native `disabled`, which would drop it from the
  keyboard order);
- its state is kept in its name or in `aria-expanded` and `aria-pressed` passed to it, never in the picture alone.

---

## 22a. DatePicker

> **Status:** IMPLEMENTING (28 October 2026: built and proven in the showcase, and reviewed the same day, with the runs recorded in [the plan's §7.50](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026); **rebuilt on 6 November 2026** (redesign step R5) on the calendar and popover primitives, behind the same public API, with one typed field in place of three parts; ACTIVE when a screen first uses it and the Product Owner accepts its look)
> **Code:** `apps/ops-web/src/components/ui/date-picker/`

One calendar date, typed as DD/MM/YYYY into one field or chosen from a calendar that opens under it. Its behaviour is the shadcn/ui calendar's (react-day-picker) and popover's (Radix UI) under a text field that reads strictly (DESIGN_SYSTEM §24a); its properties and its look are the portal's. It was the one component built on React Aria Components, which left with it (§37).

### 22a.1 Anatomy

```text
DatePicker (inside a Field)
├── group    named by the Field's label, described by its help and error (and by its own message, below)
│   ├── field    one text field typed as DD/MM/YYYY: the Field's label is a real label for it
│   └── calendar button
├── message  only when the text is not a date: in words, with the Field's own icon
└── calendar    a popover holding a dialog ("Choose a date"): the month, previous and next, the days
```

### 22a.2 Rules

- **The value is text.** `value` and `onChange` are `YYYY-MM-DD` or `null`; `minValue` and `maxValue` are `YYYY-MM-DD` or left out. A page never sees a date object. Text that is not a date of the calendar (`2026-02-30`) is drawn as no date, never as another one.
- **Reading is strict** (`day-first.ts`). Only `DD/MM/YYYY` is a date: two digits, a slash, two digits, a slash, four digits (1900 or later), and a day that is on the calendar. Nothing is guessed and nothing is corrected: not a year of fewer than four digits taken as a year (26 is not the year 26, nor 2026), not a day that its month does not have moved to one that it does (30 February is not the 28th), not a day and a month the wrong way round, not a separator that is not a slash. **Typing is helped, reading is not:** while digits are typed the slashes are put in (`28102026` is `28/10/2026`; a slash typed after one digit pads it, `3/` is `03/`; deleting leaves the text exactly as it was left, so that a part that is cleared stays cleared and the others stay where they were: `/10/2026`), and only digits and slashes are taken. A paste that holds anything else (`2026-10-28`, `28.10.2026`) is kept as it was pasted, so that the reading says what is wrong with it instead of the mask turning it into another date.
- **An impossible date is refused, and the year is required in full** (the Product Owner's decision of 7 November 2026). A **day that its month does not have** (the 29th to the 31st) is refused in words that name it, *There is no 30 February* (the same for 31 April, 31 June, 31 September and 31 November; **29 February in a year that is not a leap year names the year instead**, *2027 has no 29 February*, by the Product Owner's decision of 7 November 2026, afternoon), and is never moved to a day that exists. A **year typed in fewer than four digits** is refused with *Enter the year in full, for example 2026*, and is never taken as the year 26 or as 2026. **A year below 1900** is refused the same way, with the same words (the Product Owner's decision of 7 November 2026, task R5.2); the year arrow keys stop at 1900, so that they cannot give what typing refuses, and a date the page already holds from before (`0026-01-05`) is still drawn as it is. Both are refused the same way as any other text that is not a date: the field keeps what was typed, is invalid, says the words, and gives the page nothing. **The alternative that was rejected:** the previous field's two silent corrections, which this field carried from 6 to 7 November 2026 under the Product Owner's first decision on its tests (a year typed as 26 became the year 26, given as `0026-10-28`, and `30/02/2026` became `28/02/2026`, shown and given, in both cases without a word on leaving), because they let a person confirm a date they did not write.
- **Clear errors.** A text that is not a date says so in plain words, under the control, with the Field's icon (so the red is never alone) and the control `aria-invalid` with a 2px danger border: *Write the date as DD/MM/YYYY, for example 28/10/2026.* for a text that is not written so (or is still missing a part), *Enter the year in full, for example 2026* for a date written whole but for a year of fewer than four digits, *There is no 30 February* for a day that its month does not have (*2027 has no 29 February* for the 29th of February of a year that is not a leap year), and *That day is not on the calendar. Check the day and the month.* for a day, month or year that is not on the calendar at all (a month 13, a day 0 or 45, the year 0). The words come at once for a text that is as long as a date (`30/02/2026`, `10/28/2026`, a paste in another form), and when the person leaves the control (the field and its calendar button are one control) for one that is still being typed (a year of two digits, a month and no year; not "yet" any more); going from the field to the calendar button, or opening the calendar to finish a date, is not leaving. An empty field is no mistake. If the page held a date and the person took a part of it out (a text with a part missing), there is no message: leaving gives the page none and clears the field; a date that is written whole and refused stays as it was typed, with its words.
- **When the page hears.** The page is given a date when the text is a whole, real date, and `null` when the field is emptied; a text that is only part typed is never given (the page is not told of the year 2, then 20, then 202). **While the person is in the control the page keeps the date it held**, as the previous field's did (the Product Owner's decision of 6 November 2026): taking a digit or a part off the date does not tell the page; **leaving** the control with a part cleared, or with a refused date, tells it `null` (the part-cleared text is also cleared from the field; the refused date stays, with its words). **Enter inside the field never sends the old date** (task R5.2, 8 November 2026): while the text is not a date, Enter does not send the form; it settles the field as leaving it does (a part taken out clears the date and the field, a refused text says its words), and a second Enter, the field now settled, sends. A whole date, or an empty field, sends at once. A value the page changes (a "today" button, a clear button) replaces what was typed; a value the control itself just gave does not. The field keeps what is half typed when the page renders again with the value it has.
- **`minValue` and `maxValue`** draw the days outside them as unavailable in the calendar, where they cannot be chosen; a date typed outside them is still given and is not marked invalid. They are hints about what is worth choosing, never a rule: the page checks what it can and the server decides (sections 24 and 25). Which days a pickup can be booked for (Monday to Saturday, the cut-off, the zone's days) is the page's question and the server's answer, not this component's.
- **Language and day.** Day, month, year; the week starts on Monday; English month names; fixed by the portal and not the browser's (DESIGN_SYSTEM §24a). Today is the day in Accra and is told by more than colour: bold, with a bar under the number. A day is named for a screen reader as `Thursday, 8 October 2026`, with `Today, ` before today's and ` selected` after the chosen one; the head of a column is the first letter of its weekday (M T W T F S S); a day that is not in the month is not drawn (its square stays).
- **Inside a Field** it is named by the Field's label (a real `<label for>` leads to the field; the group takes the label's name, `aria-labelledby`, as before), described by its help and error, invalid when the Field has an error and required when the Field says so. On its own it needs `aria-label` (or `aria-labelledby`). The calendar button is named "Calendar" and the label ("Calendar, Service date").
- **States.** Empty (it shows `dd/mm/yyyy`), filled, focused (the global ring, on the field, the button or the day that has focus), invalid (the Field's error, or the control's own message), read-only (legible, focusable and selectable, no calendar: it is not styled as disabled, and its calendar button is, since it does nothing) and disabled (not focusable, no calendar). A day is today, selected (the fill of Primary, with a border that forced colours keep), hovered or unavailable.
- **Keys.** Typing; the up and down arrows step the day, the month or the year that the caret is in, for a whole date (the day goes round within its month, the month round the year, and the date is given); Tab goes from the field to the calendar button; Enter or Space on the button opens the calendar, with focus on the date, or on today; the arrows move by day and by week, Page Up and Page Down by month; Enter or Space chooses and closes, and focus returns to the button; Escape closes and changes nothing. Enter in the field: see *When the page hears*.
- **In a modal dialog** the calendar is drawn into the dialog (the page behind a modal dialog is inert, and the top layer is above the body): `Dialog` gives its element to what it holds (the popover primitive takes a `container`, [DESIGN_SYSTEM §29.6](DESIGN_SYSTEM.md#296-deviations-from-the-registry-source)), and the dialog lets an open calendar overhang its edge.
- **Size and reflow.** The control is at least `control.height.md` tall; its field is ten characters wide by nature (a date written whole) and grows into the room it is given, so a row of filters sizes it by what a date needs; the calendar button is at least 2rem square; a day is a square of 2.75rem that shrinks, if it must, until seven fit across the screen less the popover's border, so that the week fits at 320px; everything is in rem, so enlarged text grows it; the calendar scrolls inside itself and never pushes the page sideways (WCAG 1.4.4 and 1.4.10).
- **Motion.** The calendar opens over `motion.normal` (the popover primitive's animation on the token); under reduced motion nothing moves.
- **Not here:** a range of dates, a time of day, a date with a time (section 37), and a native `<input type="date">` anywhere in the application (a test fails on one).

### 22a.3 Proof

`DatePicker.test.tsx` (what a person sees, the Field's wiring, typing, the calendar's keys, the range, read-only and disabled, in jsdom: the previous field's tests with every assertion as it was written, only the way a test enters a date or finds the control changed, then what the one field adds), `day-first.test.ts` (the strict reading and the typing mask, table-driven, at the boundaries), `date-value.test.ts` (the text of a date, and today in Accra whatever the machine's zone), `test/browser/date-picker.spec.ts` (the keyboard, the focus ring on each stop, WCAG 2.2 in both themes with the calendar closed and open and with a mistake showing, the looks that only the stylesheet gives, the calendar inside a modal dialog, 320px, 200% text, forced colours and reduced motion, in three engines; forced colours in Chromium and Firefox only, since Playwright cannot emulate them in WebKit) and `test/browser/date-picker-policy.spec.ts` (a production build of the showcase under the strict content-security policy: no violation). The recorded keyboard-only and screen-reader passes, as for every component, are not part of this.

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

The queue workspace template ([PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace), approved on 5 November 2026) supersedes the presentation below, one screen at a time: **the pickup queue (`/pickup-requests`) is drawn by it since redesign step R6.1 (8 November 2026), and no longer uses `QueueTable`**; the other lists (manifests, approvals, messages, and the manifest builder's pool) still do, until step R7 moves them. This section records the queue as built, and `DataTable`, its successor, is PROPOSED in §37. Its selection is the native checkbox of §7.10; the `DataTable`'s box is another thing (task R5.2, M12).

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
  query on the screen: the docked menu takes 15.5rem (4rem as the rail), so the same screen gives a queue more or less room as the menu opens and
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
(every item once, as ids) after every move, because a sequence is sent whole and never as a change. **A move glides** (redesign step R5, 6 November
2026): the items that change place slide to it with Motion's layout animation, position only, over `motion.normal` on the enter easing, instead of
jumping; nothing moves under reduced motion, and the order, the focus and the announcement are the same either way (§37, *Motion*).

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
| Operational codes | `HUB-TT-XXXXXX` from a confusion-free alphabet, read aloud on calls; the UUID is never shown ([domain-model](../contracts/domain-model.md) §3.1) | Never truncate, re-case or re-punctuate a code. Show all of it wherever a person must quote it, and make copying give exactly the characters shown. A code stays on one line; only where it is the content of a block that can be narrower than the code (a record's title, a description value or a stop in a list, with the text at 200% on a phone) does it break where it must, whole in what is copied (task R5.2, M9) |
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

What it holds since redesign step R5 (7 November 2026): four pages (the fourth is the kit's family of pages), and the production build contains none of them (`test/build.test.ts`). `/__showcase` draws the components of `components/ui`. `/__showcase/primitives` draws every installed shadcn/ui primitive (DESIGN_SYSTEM §29.2) in the words a Melarc screen would use, with synthetic data, in both themes: a switch of the theme sits in its header and is held in memory, never stored (the Portal's own stored choice is DESIGN_SYSTEM §31's, and this switch does not write it). `/__showcase/shell` draws the parts of the shell (the sidebar expanded and as the rail, the top bar with its menus, and the command palette in each state of its search) over made-up entries, hubs and counts, on a page of its own so that the page-wide keyboard and reflow checks of `/__showcase` are not run over a second top bar. **The kit has pages of its own since redesign step R5 (6 November 2026):** `/__showcase/kit` lists the groups, and `/__showcase/kit/<group>` draws one with every variant and every state of its components, in real Melarc words and both themes (`header`, `data`, `panels`, `menus`, `forms` and `lists` in the first half; `badges`, `states` and `overlays` in the second, 7 November 2026), and three composed examples (`example-queue`, the queue workspace on the generated client's pickup-request shape; `example-record`, the record page; `example-count`, the tablet blind count at 768px with 56px targets). They are showcase pages and not routes of the application; whatever stands for data on them is labelled "Sample"; they have the same gate (`test/build.test.ts` proves the production build holds no trace of them), and `kit.spec.ts` and `kit-policy.spec.ts` drive them in a real browser. A primitive is added to its page in the change that installs it, and a part of the shell in the change that builds it.

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

Copy belongs with the feature or presentation layer. A message about permission or approval says what the account cannot do, or who decides, in plain words:
never a role and never the permission key ([PRODUCT_DESIGN_DIRECTION §6.5](PRODUCT_DESIGN_DIRECTION.md#65-on-screen-language); [surfaces/ops-portal.md](../surfaces/ops-portal.md) §7, §8).

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
| `permission-restricted` | ForbiddenState (§15) | a clear refusal that says what the account cannot do, in plain words and not by the key; hiding a control is not enforcement |

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
- [ ] landmarks correct: the sidebar (an `aside` holding the navigation), the banner (the top bar) and main, in that order, the navigation and the banner outside the main content;
- [ ] navigation focus works, with the inverse ring on the Ink sidebar;
- [ ] current location clear, by more than colour;
- [ ] no navigation entry inferred from a role name;
- [ ] no entry for a route that is not built, and none for a key the session does not hold;
- [ ] sign-out reads as done for `204` and `SESSION_INVALID`, and otherwise leaves the person signed in with a retry.

### ForbiddenState, EmptyState, Skeleton, StatusBadge (S0.40)
- [ ] a refusal says what the account cannot do in plain words, and names neither the permission key nor a role, in every kind;
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

### The planned kit

**Product Owner, 5 November 2026.** The Ops Portal redesign needs the components below. **Each pattern has one status (§2), and it is the one its row gives:** redesign step R4 built the five of the shell (AppShell v2, CommandPalette, NewMenu, AccountMenu and HubSwitcher) and task C1 built CountBadge, and those six are **IMPLEMENTING**; redesign step R5 (first half, 6 November 2026) built Tabs with counts (`ViewTabs`), FilterBar, DataTable, SidePanel (with its sheet), RecordHeader with StageTracker, ActionMenu, DescriptionList, Panel and Card, StatTile and Toast, and the PageHeader of the redesign (which this table does not list), and those are **IMPLEMENTING** too (built, no screen uses them yet, not yet accepted); and the second half of step R5 (7 November 2026) built Tooltip and Popover, EmptyState v2, Skeleton v2 with LoadingRow, StatusBadge v2, CountBadge's variants and Avatar, which are **IMPLEMENTING** as well (built, in the showcase, accepted by nobody yet); and step R6 (8 November 2026) built the four page templates (*the four page templates*, below), **IMPLEMENTING** too, so **no row of this table is PROPOSED and none is ACTIVE**. The register of §40 holds the same statuses. All are composed in `components/ui` from the shadcn/ui primitives that step R3 installed ([DESIGN_SYSTEM §29.2](DESIGN_SYSTEM.md#292-the-component-foundation)), each to §3 and to [DESIGN_SYSTEM §28](DESIGN_SYSTEM.md#28-component-implementation-rules). A component becomes IMPLEMENTING with its first code, and ACTIVE once a screen uses it and the Product Owner has accepted it. The list is [DESIGN_SYSTEM §27](DESIGN_SYSTEM.md#27-initial-implementation-scope)'s.

| Pattern | What it is for |
|---|---|
| AppShell v2 | the signed-in frame: the sidebar of seven groups with counts, and the top bar ([surfaces/ops-portal.md §4](../surfaces/ops-portal.md#4-navigation-model)). **Built in redesign step R4** and **IMPLEMENTING** (§2): `components/ui/app-shell/` (`Sidebar`, `MobileSidebar`, `TopBar`), drawn by `app/shell/`; as built in §12.6 |
| CommandPalette and global search | opening any record by its code, a name or a phone number (Ctrl/Cmd K). **Built in redesign step R4** and **IMPLEMENTING** (§2): `CommandPalette` and `SearchButton`, with `app/shell/ShellPalette.tsx` over `lookupRecords`; the search is a button that looks like a field (§12.6) |
| NewMenu | every create action, gathered in one menu. **Built in redesign step R4** and **IMPLEMENTING** (§2): `NewMenu`, over the `dropdown-menu` primitive, the one crimson `brand` button of the portal |
| AccountMenu | personal settings (trusted browsers, the theme) and sign-out. **Built in redesign step R4** and **IMPLEMENTING** (§2): `AccountMenu`, which offers no "profile and hubs" page because none exists |
| HubSwitcher | the hub a person browses, and acts in. **Built in redesign step R4** and **IMPLEMENTING** (§2): `HubSwitcher`, with the choice held by `platform/hub` and read by `useActiveHub` |
| Tabs with counts | the views of a queue ([PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace)) |
| FilterBar with chips | a queue's filters, each applied choice a chip that can be removed |
| DataTable | the queue table, with selection, a bulk-action bar and an inline row action: TanStack Table, which redesign step R3 adopted, over the table primitive ([DESIGN_SYSTEM §23](DESIGN_SYSTEM.md#23-tables-and-dense-operational-data)). It builds on Table and QueueTable (§19, §22f) |
| SidePanel and Sheet | a record beside its list, and a full-screen sheet at 768px |
| RecordHeader with StageTracker | the record's code, status, stage tracker, primary action and "more actions" menu ([PRODUCT_DESIGN_DIRECTION §6.2](PRODUCT_DESIGN_DIRECTION.md#62-record)) |
| ActionMenu | the overflow menu of a record's acts, destructive acts last |
| DescriptionList | the facts of a record, grouped and labeled |
| Panel and Card | the surfaces of the record template |
| Toast | success after a task, with "Open" and "Do another" |
| Tooltip, Popover | the name of an icon, and the longer explanation behind an info control. **Built in the second half of redesign step R5** and **IMPLEMENTING** (§2): `Tooltip` and `Popover` in `components/ui`, over the `tooltip` and `popover` primitives, with Melarc's defaults (300ms, 8px, the floating shadow); as built below |
| Dialog wrappers | the modal dialog and the question before a hard-to-undo act, so that a page never touches a primitive. **They are the `Dialog` and `AlertDialog` of §20**, ACTIVE; no second modal was built, which the Product Owner accepted on 7 November 2026 (afternoon) provided they carry the Melarc defaults: the motion was added then, and the defaults are listed below |
| StatusBadge v2 | the status of a record: five pairs, a dot, plain words, and one table of every state. **Built in the second half of redesign step R5** and **IMPLEMENTING** (§2): `components/ui/status-badge/` and `app/status/status-table.ts`; as built below |
| Avatar | a person's tile: the initials, or a picture once it has loaded. **Built in the second half of redesign step R5** and **IMPLEMENTING** (§2): `components/ui/avatar/` |
| StatTile | a figure the server states |
| CountBadge | a count in a menu or a tab, **built early, by task C1** (5 November 2026), because the queue summary is the first count the server states: `components/ui/count-badge/`, from the Badge primitive and the tokens, drawn beside the sidebar's entries (redesign step R4). It is **IMPLEMENTING** (§2). It draws a whole number it is given, never capped (a capped figure hides the size of a queue), with the words of what it counts for a screen reader, a count of `0` that was read quietly, and **nothing at all for a count that was not given**: a count that is loading, missing or failed is never drawn as `0` (§24, §25). On the sidebar it takes the shell's own tokens, white on the pressed ground, on the filled current entry a pill of white at 18% (at 22% the white text on the crimson measures 4.32:1, below the 4.5:1 of the specification), and, on the rail, under the icon inside its entry (12px, not scaled). **The second half of redesign step R5 (7 November 2026) added its variants** `subtle` (the default), `strong` (Ink) and `on-crimson`; as built below |
| EmptyState v2, Skeleton v2 | the empty and loading treatments, redrawn: a deliberate replacement of §16 and §17, which stay ACTIVE until their screens migrate (§2). **Built in the second half of redesign step R5** and **IMPLEMENTING**: `EmptyStateV2`, and `SkeletonBar`, `SkeletonCard` and `LoadingRow` (the DataTable draws `LoadingRow` for its loading rows); as built below |

A count or a figure on these components is the server's: the component draws what it is given and works nothing out (§24, §25).

### The kit as built (redesign step R5, first half, 6 November 2026)

The first half of step R5 built the components below, in `components/ui`, each composed from the shadcn/ui primitives of step R3 and from nothing else (a page imports the component; the primitive and the libraries under it stay behind their door: [DESIGN_SYSTEM §29.2](DESIGN_SYSTEM.md#292-the-component-foundation)). Each is built and is in the lifecycle of §2 as IMPLEMENTING, and ACTIVE once a screen uses it and the Product Owner has accepted it. No screen uses one yet (steps R6 and R7 move the screens). The second half (StatusBadge v2, CountBadge's variants, EmptyState v2, Skeleton v2 and LoadingRow, Avatar, Tooltip and Popover, and the decision on the Dialog wrapper) was built on 7 November 2026 and is described after *Motion*, below.

**Rules every one of them keeps** (and its tests say so): it draws from the tokens alone; it covers the interface states that apply to it (§33.1); it is fully operable from the keyboard and shows the global focus ring; it passes axe (WCAG 2.2 A and AA) in both themes, in jsdom where that is meaningful and in Chromium on every showcase page; it moves only on the motion tokens, and not at all under `prefers-reduced-motion: reduce`; it **draws what it is given and works nothing out** (a count, a total, a state, a time: §24, §25), so a figure that was not given is not drawn, and a missing figure is never `0`; it takes **slots, not other kit components** (`ReactNode` for a status badge or a menu), so that the second half changes the callers and not the kit; and it is in the showcase (§27) with real Melarc words, every variant and every state, the sample data labelled "Sample". Words of the components are plain and short; none names a permission key or a role.

**Not built, and why.** A "select all" in the DataTable (the rule of §22f stands: a choice of the whole page is a decision the screen has not been asked for). Sorting, filtering and paging inside any component (the server's). A tooltip for a disabled item: a disabled control takes neither a pointer nor focus, so a tooltip cannot be on it, and the reason is in the item itself (see ActionMenu below). What the second half leaves unbuilt is said at the end of its description.

**Two small helpers the kit uses** and a page may: `OperationalCode` (`components/ui/code/`: a code in the monospaced face at weight 600, never shortened, and wrapped only where its block is narrower than it, §24.1) and `VisuallyHidden` (`components/ui/visually-hidden/`: words for whoever hears the page, kept out of the way of the eye).

#### PageHeader (the kit's)

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/page-header/`

The header of a page of the redesign: the title (the page's one level-one heading, through the existing `PageHeading`, which takes focus after a navigation), how many there are where the server stated a count, how fresh the results are and the way to refresh them, the pages above, and the page's actions. The initial PageHeader of §11 (`src/components/PageHeader.tsx`) stays ACTIVE, and the twenty pages that import it are unchanged, until steps R6 and R7 move them.

- **Props.** `title`; `description?`; `count?` (`{ value, noun }`: the number the server stated and what it counts, "pickup requests", said to assistive technology with the number); `freshness?` (`{ state?: 'idle' | 'refreshing' | 'failed', updatedAt?, onRefresh }`; `updatedAt` is the time already written the way the portal writes one); `breadcrumb?` (`{ label, to }[]`, the pages above, not the page itself); `actions?`.
- **States.** *Loading*: leave `count` out (it is never drawn as `0`) and show `refreshing`. *Error*: `failed` says "Refresh failed. Last successful check: 09:42" (or "Refresh failed." when none ever worked) and Refresh is the retry. *Stale*: the last good time stays. A page never read has no freshness line. Empty, validation and permission-restricted do not apply: the header draws no refusal, and an act the person cannot take is not passed in.
- **Keys.** Tab through the trail, Refresh and the actions. Refresh stays focusable and says it is busy (`aria-busy`) and ignores a press while a read is under way: one read at a time.
- **Do** pass the count only when stated, and a `0` that was read (it is drawn quietly); keep one primary action in `actions`. **Do not** pass `0` for a count still loading; put a refresh button of your own beside it; use it where the old PageHeader is still imported (the two are not mixed on a page).

#### ViewTabs

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/view-tabs/`

The views of one queue as tabs with counts ([PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace)): the Tabs primitive (Radix UI), with the current view's count as an Ink pill and a 2px underline that grows in over `motion.normal` (a transition of the stylesheet on the token, so it is instant under reduced motion).

- **Props.** `label` (names the list), `tabs` (`{ id, label, count?, disabled? }[]`), `value`, `onValueChange`, `children` (the current view's content: the tab panel, tied to its tab).
- **States.** *Loading*: a tab with no `count` draws no pill. A `0` that was read is drawn quiet. A view the person may not use is not passed in (hiding is presentation); `disabled` is for a view that cannot be chosen now. Two views with one id throw (a defect of the page). A current view that is not in the list (the address named one that does not exist, or no longer does) draws the first view that can be chosen and does not call `onValueChange`: what the address means is the page's to decide (task R5.2, M12).
- **Keys.** Tab enters the list at the current view and leaves it in one stop; the arrows move focus only, and Enter or Space chooses (manual activation, task R5.2, M12: an arrow never reads the server, so a person looking for a view does not start a read of every view they pass); Home and End go to the ends; a disabled tab is skipped. The list scrolls inside its own box on a narrow screen.
- **Do** keep the current view in the address; give the counts the server stated. **Do not** compute a count from the rows on the page, or draw `0` while a count is being read.

#### FilterBar

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/filter-bar/`

What a queue is filtered by: each applied choice a chip that can be removed on its own, a dashed "+ Filter" button that opens the page's fields in a popover (the Popover primitive), and the order of the rows told at the end.

- **Props.** `label`, `chips` (`{ id, label }[]`: "Service date: this week"), `onRemove(id)`, `onClearAll?` (offered from the second chip on), `filterPanel?` (the page's fields; without it there is no button), `filterLabel?`, `sortLabel?` ("Sorted by oldest first"). **Controlled popover (task R5.2, M12):** `filterOpen?` and `onFilterOpenChange?` let the page open or close it (to close it when the fields are applied). The popover is the kit's `Popover`, so it keeps 8px from the edges of the window (on a 390px screen it never touches the glass) and is drawn into a dialog when the bar is in one. The remove button of a chip is the kit's `IconButton`, kept to 24px.
- **States.** None applied (only the button); one or many (they wrap); the popover open; a chip removed. It holds no filter and filters nothing: the page holds them (in the address) and the server answers. The fields in the popover carry their own validation.
- **Keys.** Tab through the remove buttons and the Filter button. After a removal focus goes to the next chip's remove button, else the previous one, else the Filter button, so it is never lost. Enter or Space opens the popover with focus inside; Escape closes it and gives focus back to the button.
- **Do** write a chip as the choice would be said. **Do not** put a filter here that the server does not take, or use the bar to sort (it only says how the rows are ordered).

#### DataTable

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/data-table/`

The queue table: TanStack Table's model (columns, row model, selection, manual sorting) over the table primitive ([DESIGN_SYSTEM §23](DESIGN_SYSTEM.md#23-tables-and-dense-operational-data)). It builds on Table and QueueTable (§19, §22f), which stay ACTIVE until step R7 moves the pickup queue.

- **Rows.** 36px single-line, 52px where a cell holds a code over a name (`RowTitle`), 56px for the hub-floor tablet (`density: 'single' | 'two-line' | 'touch'`), each with its 1px separator inside it, or as tall as its tallest control (a touch row that holds a 56px control is 57px, or 65px where the page puts air around it); **a cell wraps at its words and the row grows to hold the lines** (a code, a date and a count are kept to a line by the screen, which marks them with the kit’s `NoWrap`), so that no word is cut off or left to a tooltip, and the name under a code is whole, never ellipsised (the review of 5edada2, M5); codes in the monospaced face at weight 600. **The whole row opens its record through a real button in the code cell, stretched over the row** by its pseudo-element (no handler on a row or a div); the controls of other cells stay above it.
- **Props.** `label`, `columns` (`{ id, header, cell, rowHeader?, align?, width?, sortable? }`; the row-header column holds the code), `rows` and `rowId` (in the order the server gave), `density?`, `onOpen?` with `openLabel` ("Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd", which contains the visible words), `selection?` (`selectedIds`, `onChange`, `selectLabel`, `isSelectable?`, `bulkActions?`), `rowAction?` (`label`, `ariaLabel?`, `onRun`, `isAvailable?`), `changedIds?`, `sort?` and `onSortChange?`, `status?`, `loadingRows?` and `loadingLabel?`, `error?`, `emptyState?`, `stale?`, `footer?`, `maxHeight?`, `initialScroll?` and `onScrollChange?`, `focusRowId?`. **Added by task R5.2 (M12):** a column takes `priority?` (1, 2 or 3), the table takes `card?` and `layout?` (cards in place of the table where its box is narrow), and a bulk act takes `eligible?` and `note?`; each is described below. **Added in RUN 4:** `crowded?` (what an `auto` table does where its box is too narrow for every column), `busy?` (the rows are read again and stay) and `ref` (`DataTableHandle`: `focusRow(id)` and `focusResults()`); the table also exports `RowTitle` and `NoWrap`. **TanStack Table is imported by this component alone** (an ESLint rule and `test/tanstack-door.test.ts`): a screen gives it columns and rows and never builds a grid of its own.
- **Selection.** A checkbox for each row named "Select CODE"; the page holds the ids (they may include rows of other pages). A bar slides in over `motion.normal` (Motion) with "2 selected", the acts (the first marked `primary` in Ink: "Confirm 2") and Clear; it comes **above the rows** and sticks under the top bar (task R5.2, M12), where the last rows are never covered and a thumb on a tablet is not in the way: the rows move down by its height once, when it comes. It announces the count once, in words. Bulk acts are only for acts that are safe and atomic ([surfaces/ops-portal.md §10](../surfaces/ops-portal.md#10-what-this-surface-must-never-do)). Selected rows take `surface.selected`.
- **Only the rows an act can be taken on** (task R5.2, M12). A bulk act takes `eligible(selectedIds)`, the screen's own rule (the table cannot judge rows that are on other pages), and gives back the chosen ids the act applies to: the label counts those ("Confirm 2"), `onRun` is given those, and the act is **not drawn** when none is. `note(left)` says in the screen's words how many were left out ("1 is already confirmed or cancelled"). Eligibility is the screen's and the server's: the table only counts, and the server decides whatever the bar offers.
- **Column priority** (task R5.2, M12). A column's `priority` says how much it matters when the table's own box is narrow (not the window: a side panel opened beside the table narrows the box): **1** is always drawn (the default), **2** goes first when the box is under 48rem and **3** before that, under 64rem, so that a table with a panel open beside it at 1440px never needs a sideways scroll. The row-header column and the box are always drawn. A hidden column leaves the page and the accessibility tree; which columns may go is the screen's choice, the table cannot know. **`crowded`** says what the table does where it is too narrow for every column, which is at or under 64rem for a table that has a column marked lesser: `drop` (the default) takes those columns away, which is right where what they hold is at hand beside the table (a docked panel shows the record); `cards` draws the cards instead, with every fact, which is right where nothing else shows them. The queue workspace sets it from the panel's state (a panel docked beside the table: `drop`; none, or the full-screen sheet of a tablet that covers the table: `cards`), so that at 768px with no panel the queue shows what its cards showed (the review of 5edada2, M6). A table with no column marked lesser, such as the builder's pool, is cards only under 40rem.
- **Cards** (task R5.2, M12). With `card`, under 40rem of the table's own width the rows are drawn as cards in place of the table (a 390px phone): the facts as words with no control in them, and the table draws the card's one hit target (the button that opens, stretched over the card), its box and its act. The keys, the box, the open button and the row act work as they do in the table. `layout` fixes `table` or `cards` where a screen knows better. Without `card` the table stays a table and scrolls sideways.
- **Hit areas** (task R5.2, M4). The button that opens a row is stretched over the whole row, and a field, a select, a link or a button in a cell is lifted above it, so a press on one is its own and never opens the record. The box of a row is in a label as large as its cell (at least 44 by 36px), so a press beside the box chooses the row and opens nothing.
- **The inline act** of a row shows on hover, on focus and when the row is chosen (always on a touch screen), and is always in the page and the keyboard order.
- **A changed row** (`changedIds`) takes a tint that fades over `motion.highlight` (900ms; a stylesheet on the token, so it is not seen under reduced motion). It is a cue for the eye only: the row also says "Updated" to assistive technology, and the page says it in words where it matters.
- **Header and box.** The box sets `overflow-anchor: none`, so that rows that come and go above the person's place do not shift what they are on. The header is sticky within the table's own box, which scrolls both ways (and takes focus, named by the label), so a wide table never scrolls the page. `maxHeight` bounds the box so that the header can stay while the rows move. A control that takes focus is never left under the header or under the bar of acts (`scroll-padding` and `scroll-margin`: a person going up through a long table keeps the control in view, task R5.2, M6).
- **States.** *Loading*: `LoadingRow`s (§37, *Skeleton v2*) of the table's own shape, the table `aria-busy`, a status in words, never a number. *Empty* and *filtered to nothing*: the page's `EmptyState` (§16) or `EmptyStateV2` (§37), which tell them apart. *Error*: the page's words (mapped from the code, never the diagnostic message) with Retry. *Stale*: the last rows stay under a line that says so and offers the read again. *Busy* (`busy`): the rows are being read again **after an act** and stay as they are, in place, with the person's focus and the row that changed; the box says it is busy (`aria-busy`) and draws no loading rows (a read that must not be taken for an answer is *Loading*). *Success*: a changed row. It never draws a total it was not given. The live regions (the loading words, the stale line, the error and the count of the chosen rows) are **in the page before they have anything to say** and are filled, because most screen readers announce a change of a region that was there and not a region that appears with its words (task R5.2, M10).
- **Returning.** The table holds no state of its own that a return must keep: selection is the page's; `initialScroll` and `onScrollChange` let the page keep the box's place in memory (never in the address or a storage), and `focusRowId` puts focus back on the row the person came from. Filters are the FilterBar's, the page's. `focusRowId` takes focus **once**, and a later change of the rows does not take it again (a read that refreshes the rows does not pull focus from where the person went); to put focus on a row again (after an act that changed it) or on the results, **a page asks the table through its handle** (`focusRow(id)`: the control of the row as it is drawn now, table or cards, by the least scroll and clear of the top bar, matched without regard to case; `focusResults()`) and **never looks for a class of the kit's markup**: `test/pages-no-kit-classes.test.ts` fails if a file of `src/app/` names one; `initialScroll` is put back **once, when the rows first arrive**, since a table that draws loading rows first has no height to scroll to until then (task R5.2, M7).
- **Keys.** Only one row's controls are in the Tab order, so Tab crosses the table in a few stops; the up and down arrows, Home and End move between rows; **Enter opens the record; Space chooses the row and does not open it**; a field in a cell keeps its arrows, and so does a menu or a combobox in one (a control that takes the arrow for itself is left alone); a row with nothing to focus is stepped over. The keys are described to assistive technology.
- **Do** order, filter and page on the server and pass the rows as they came. **Do not** add a select-all, a total, a sort of the rows in the browser, or an act that is not safe in bulk, and do not put the muted text on a chosen row (it is 4.2 to 1 on the selected tint: the name under the code takes the secondary text there).

#### SidePanel

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/side-panel/`

A record beside its list ([PRODUCT_DESIGN_DIRECTION §6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace)): 360 to 420px wide, 12px corners, the floating shadow (the panel floats), sliding in 18px with a fade over `motion.slow` (Motion; it appears at once under reduced motion). At 768px and below it is a **full-screen sheet** (a modal dialog on the sheet primitive).

- **The state in the header is the panel's own read's** (the review of 5edada2): a page that shows a record in its panel hands the panel the state its own read of the record gave, never the state of the list's row, which is older than the panel's answer; until that read has answered the header shows none. The panel is bounded to the window below the top bar (`--sticky-room`, DESIGN_SYSTEM §14): its header stays and its body scrolls inside it.
- **Props.** `open`, `onClose`, `code` (the record's code: its name and heading), `status?` (a slot for the StatusBadge), `fullPage?` (`{ to }`: "Open full page"), `children` (the page's summary, with its own loading, failure and refusal), `returnFocusTo?`.
- **States.** The header shows at once with the code; *loading*, *error*, *retry*, *stale* and *permission-restricted* are what the page puts inside (a `ReadState`, a `DescriptionList` with `loading`). Opening another record replaces the content and moves focus to the new heading.
- **Focus.** It moves into the panel (the heading) when it opens, and **back to the row** (the control that was focused when it opened, or what `returnFocusTo` names) when it closes: in the sheet always (a modal keeps focus inside while it is open), and in the docked panel **only if focus was inside the panel or lost with it**, so a page that closes the panel while the person is in a filter does not pull them back to the row (task R5.2, M7). Escape closes it; an Escape that something inside it (a menu, a popover) has already taken does not. The docked panel is a non-modal `dialog` named by its code; the list beside it stays in reach. The sheet is modal and keeps the page out of reach.
- **Do** put the page's own summary inside, and keep the filters, the scroll and the selection of the list alive behind it. **Do not** make the panel the only place an act can be taken, or draw an act the person cannot take.

#### RecordHeader and StageTracker

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/record-header/`

The top of a record ([PRODUCT_DESIGN_DIRECTION §6.2](PRODUCT_DESIGN_DIRECTION.md#62-record)): the code in the monospaced face at 26/32 (the page's heading through `PageHeading`, or a level-two heading when it is in a panel: `level`), the status (a slot), one sentence in plain words of where the record stands and what can be done next, the stage tracker, **one primary action in Ink**, other actions and the menu.

- **Props.** `code`, `level?`, `status?`, `sentence?`, `stages?` (`StageTrackerProps`), `primaryAction?`, `secondaryActions?`, `menu?` (an ActionMenu). `StageTracker`: `label`, `stages` (`{ id, label }[]`), `currentId`.
- **StageTracker.** Segmented bars with labels: the stages before the current one in the secondary text colour, the current one in the brand crimson with a small crimson square beside its label, the ones after it in the border colour (their label in the muted text, since a border colour is not legible as text). The state is also told in words ("Done", "Current stage", "Not reached") and `aria-current="step"` marks the current one, so colour is never alone. The stage is the server's fact, passed as given; a current stage that is not one of the stages throws. The stages stack when the room the tracker is in is narrow (a container query, 30rem), not only when the window is: a tracker in a column beside a list is as narrow as one on a phone.
- **States.** *Loading*: the code is known; leave the status and the tracker out until they are (they are never guessed). *Stale* or *conflict* is the page's banner above the header. An act the person cannot take is not passed in (hiding is presentation; the server decides). A stage that is not in `stages` (a state the page does not know yet) is drawn as **unknown**: every bar neutral, no `aria-current`, "Unknown stage" in words, and never "done" or "not reached" for a stage that is not known (task R5.2, M12; two stages with one id still throw). **Inside a SidePanel** the code is not a second heading: the panel's own heading names the dialog, and the header draws the code as text in the code face.
- **Do** keep to one primary; say what stands in the way in the sentence. **Do not** draw a tracker for a record that has no such way (a cancelled one), or colour a stage the server did not put there.

#### ActionMenu

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/action-menu/`

The overflow menu of a record's acts behind a "⋯" button: the Dropdown Menu primitive (Radix UI).

- **Props.** `label` (names the button: "More actions for ACC-PR-7KQ2MZ"), `items` (`{ id, label, icon?, onSelect, disabled?: { reason } }`, and for a destructive one `destructive: true` with `confirm: { title, description, confirmLabel }`).
- **Destructive acts are last, in vermilion, and always confirmed.** The component puts them last (a caller cannot place one among the others), draws them in the danger colour behind a separator, and the type refuses a destructive item without its confirmation. Choosing one closes the menu and opens an `AlertDialog` whose safe button, **Go back**, is focused first (a dismiss never repeats the verb of the act it dismisses: here the act is a cancellation); the act runs only when it is confirmed, and focus goes back to the button either way.
- **An act that cannot be taken** stays in the menu and in the keyboard order, and **says why in plain words** (never a key or a role) on hover, on focus and when it is chosen (a touch screen has no hover); the reason is also its description for assistive technology. It does nothing and the menu stays open.
- **Keys.** Enter, Space or the down arrow opens; the arrows, Home, End and typing move; Enter chooses; Escape closes and gives focus back.
- **While an act runs and when it fails** (task R5.2, M3). The `onSelect` of a destructive act may return a promise of an `ActionOutcome` (nothing, `{ ok: true }` or `{ ok: false, message }`): the confirming button is busy and the question stays open until it settles, and a failure is said in the question itself, in the page's own words (never the API's message) and with the way to try again or go back, never as a toast under the scrim, so that a person is not left wondering whether the act happened. An item may carry its **own dialog** (a reason to give) in place of the question; the menu then stays out of the way until it is answered. The menu is drawn into a dialog when it is opened from one, and is never wider than the window, whatever the size of the text.
- **Do** keep it to the rarer and heavier acts; the primary act is a button beside it. **Do not** put an act here that is not offered to the person at all, or write a reason that names a role.

#### DescriptionList

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/description-list/`

The facts of a record, grouped and labelled ([PRODUCT_DESIGN_DIRECTION §6.2](PRODUCT_DESIGN_DIRECTION.md#62-record)): a `<dl>` with a **110px label column**, muted labels, and values that may hold codes (`code: true` sets a text value in `OperationalCode`).

- **Props.** `items` (`{ label, value?, code? }[]`), `heading?` (a section label: 11.5px, capitals, muted) and `headingLevel?`, `loading?`, `missingText?` (default "Not recorded").
- **States.** *Loading*: the labels stay and every value is a bar; none is drawn before it arrives. A value the server did not state says "Not recorded" in words, never a blank, a dash or a `0`. Under 24rem a label sits over its value. The region that says it is loading is in the page before it loads, and the same one is filled (task R5.2, M10). A phone number on a record's own page is shown whole (§12.6); a code in a value breaks where it must in a narrow block (§24.1).
- **Do** group the facts by meaning under section labels. **Do not** invent a value, or draw a placeholder as a result.

#### Panel and Card

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/panel/`

The surfaces of the queue and record templates: the Card primitive on the default surface with the subtle border and **12px corners**, no shadow (it sits on the page); `variant="page"` is the **page card** at 16px.

- **Props.** `title?` and `headingLevel?`, `action?` (needs a title; one throws without), `variant?: 'panel' | 'page'`, `padding?: 'default' | 'none'` (`none` for a table that runs to the edges), `children`.
- **States.** None of its own: the content shows its loading, failure and refusal. A panel with no title has no header.
- **Padding `none`** is for content that runs to the edges (a table): the panel cuts it to its rounded corners (`overflow: clip`, which unlike `hidden` is not a scroll container, so that a sticky bar inside the panel sticks to the page and not to a box that never scrolls; task R5.2, M12), so what is inside draws its focus ring inside itself (the DataTable's scrolling box does).
- **Do** use the panel for a group of facts or acts on a record and the page card for the one card that holds a queue; choose the heading level from the page's outline. **Do not** add a shadow (a panel is on the page, it does not float), nest a panel in a panel, or give the page card to a small group.

#### StatTile

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/stat-tile/`

A figure the server states: an 11.5px label in muted capitals (0.06em), a 22px figure in weight 700 and tabular numbers, and a caption.

- **Props.** `label`, `value?` (a number, grouped as the portal writes figures, or text the page formatted), `caption?`, `loading?`, `countUp?`.
- **States.** *Ready*; *loading*: a bar, never a number; *not available* (no value given): a dash and the words "Not available", **never `0`**; a `0` that the server stated is drawn. `countUp` counts the figure from 0 over `motion.highlight` **once**, the first time it is shown (Motion); a later figure is shown at once; under reduced motion the figure is there at once. While it counts, assistive technology reads the final figure and not the numbers on the way.
- **Do** pass a figure the server stated. **Do not** pass a sample as a result, or a stand-in for a figure that failed to load.

#### Toast

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/toast/` · See §21 for the rules it implements.

A message at the bottom right on the Sonner primitive: a 22px disc of the tone's status pair with its icon, the message, **up to two actions** (a primary and a secondary one, under the message) and, when it has any, a way to dismiss it.

- **API.** `showToast({ tone, message, action?, secondaryAction? })` (`tone`: `success`, `info`, `warning` or `danger`; `action: { label: 'Open' | 'Undo', onClick }`: **the type allows no other word there**; `secondaryAction: { label, onClick }`, the next act in the screen's own words ("Book another") and never "Undo": **it exists only beside a primary action, which the type and the run time both hold**), `dismissToast(id?)`, and `<Toaster />`, **mounted once, in the signed-in frame (`AuthenticatedOpsShell`)**, where a second one anywhere draws nothing. The state is the server's: say what was reached, not that a request returned. The `message` is text, or text with an `OperationalCode` in it, so that a code is kept whole on one line and not broken like a word.
- **A toast with any action stays until it is dismissed** (WCAG 2.2.1), and using either action takes it away; one without goes after six seconds. **Undo only where the server allows undoing that act**; Open where the act made something to open. An important outcome is never only a toast: it is the page's too.
- **Keys.** The toast appears without taking focus; Alt+T (Sonner's hotkey) moves the keyboard to the toasts; Tab reaches the primary action, the secondary one and the dismiss button, in that order; focus returns. It is announced politely.
- **Held, named and kept clear** (task R5.2, M11). A toast raised while a native modal dialog is open is **held** and shown when the last one has closed, in the order raised, since a modal dialog makes everything outside it inert and a toast behind its scrim would be found late. A toast may carry an `id`: raising it again replaces the one that is showing (or held) in place and does not stack a second. Under 600px it stands above a control that sticks to the bottom of the window (a page's submit bar), which publishes its height with `useToastClearance`. Its dismiss button is the kit's `IconButton`, kept to 24px. When the session ends, every toast, showing or held, is dropped with it: one with an action has no end of its own, and would appear again for the next person.
- **Do** raise it for what already happened and is also shown on the page; leave the one `<Toaster />` to the frame (a page never mounts one). **Do not** put the only record of an outcome, an error that needs a decision, or more than two actions in a toast, and do not raise one from a page except through `showToast`.

#### Motion

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/motion/` · [DESIGN_SYSTEM §24a](DESIGN_SYSTEM.md#24a-interaction-primitives)

The animation library (`motion`, an exact pin, its licences shipped) behind one door, `components/ui/motion/motion.ts`: only the components of `components/ui` import it, a page never does. A component never writes a duration or an easing: `useMotion()` reads them from the motion tokens of `tokens.css` (120, 200, 280 and 900ms, the enter and exit easings) and gives every transition as instant when the person asked the system for less motion (the same preference that sets the tokens to zero for the stylesheet).

- **Used for what a stylesheet cannot do:** the reordered list's layout glide (`ReorderList`), what comes and goes (the DataTable's bar of acts, the docked `SidePanel`), and a number that counts (`StatTile`).
- **Left to the stylesheet, on the same tokens:** the tab underline growing in, a changed row's highlight, the inline act's appearance, hover and press. They are off under reduced motion because the tokens are zero, with no script.
- **Proof.** `test/motion-door.test.ts` (one door, and no duration or easing outside the tokens), `test/motion-tokens.test.ts` (the fallback numbers equal the token file), `test/motion-licences.test.ts`, the component tests (instant under reduced motion) and `kit.spec.ts` and `kit-policy.spec.ts` (what moves in a browser, and that the strict policy raises no violation).

### The kit as built, second half (redesign step R5, 7 November 2026)

The second half of step R5 built the components below to the rules of the first half (above), in `components/ui`. Each is **IMPLEMENTING** (§2): built, in the showcase (`/__showcase/kit/badges`, `states` and `overlays`) with every variant and state in both themes, proven in jsdom and in a browser; **none is ACTIVE**, and the Product Owner has not accepted them. Two of them changed a component in place, and say so: StatusBadge now draws v2 wherever it was drawn, and the DataTable now draws `LoadingRow`. The other pages are unchanged: `EmptyState` (§16) and `Skeleton` (§17) stay ACTIVE and are what the pages draw until their screens migrate (§2), and no page was moved.

#### StatusBadge v2

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/status-badge/` and `apps/ops-web/src/app/status/status-table.ts`

The status of a record in words (§18 is the pattern; this is its look and its table). **Five pairs**, the R2 status pairs of [DESIGN_SYSTEM §4.4](DESIGN_SYSTEM.md#44-status-tokens), a foreground, a soft background and a border each: `waiting` (what is held for someone or something: the tokens' *warning* pair), `success`, `info`, `neutral` and `danger`. **A 6px dot** in the foreground colour, hidden from assistive technology, stands before the words: the words carry the meaning, and the colour and the dot support them.

- **Props.** `status` (a string: what arrives from a server is a string until it is checked), `map` (a `StatusMap<Value>`, typed over the whole enumeration) and `unknownLabel?`. A mapping's `tone` is a pair; `warning` is still accepted as the old name of `waiting` (`pairOf`), so no mapping of a page changed or has to change for the badge to draw v2 (the rename is mechanical and belongs to the screens' steps).
- **States.** A value the mapping does not have is the neutral pair with "Unknown status" and the dot, never the raw value (§18).
- **The one table.** Every state that a screen of the portal shows, and every state that the search of records can return, is in `STATUS_TABLE` (`app/status/status-table.ts`), which gathers the mappings the screens already use (each typed over its enumeration, so a state the contract adds is a compile error where its mapping is written). The search words a state from the same mappings (`app/shell/record-line.ts`), so a state is called the same thing in the palette and on its page. `status-table.test.ts` holds the table to four things: **the contract's enumerations** of the five kinds the search finds (a state in the contract with no row fails), **the search's own words**, **every mapping that a page declares** (a new `StatusMap` that is not in the table fails), and **this document, row for row**. To change a state, change its mapping and its row here, and nothing else. The pairs and the words are those the screens already gave; this table records them, and a change of one is the Product Owner's.

| Domain | State | Pair | Words |
|---|---|---|---|
| `PICKUP_REQUEST` | `PENDING` | waiting | Waiting for confirmation |
| `PICKUP_REQUEST` | `CONFIRMED` | success | Confirmed |
| `PICKUP_REQUEST` | `DECLINED` | danger | Declined |
| `PICKUP_REQUEST` | `CANCELLED` | neutral | Cancelled |
| `PICKUP_MANIFEST` | `DRAFT` | waiting | Draft |
| `PICKUP_MANIFEST` | `DISPATCHED` | info | Dispatched |
| `PICKUP_MANIFEST` | `IN_PROGRESS` | info | In progress |
| `PICKUP_MANIFEST` | `COMPLETED` | success | Completed |
| `PICKUP_MANIFEST` | `CANCELLED` | neutral | Cancelled |
| `PICKUP_STOP` | `PENDING` | neutral | To be worked |
| `PICKUP_STOP` | `ARRIVED` | info | Rider arrived |
| `PICKUP_STOP` | `COLLECTED` | success | Collected |
| `PICKUP_STOP` | `PARTIALLY_COLLECTED` | waiting | Partly collected |
| `PICKUP_STOP` | `FAILED` | danger | Failed |
| `PICKUP_STOP` | `SKIPPED` | neutral | Skipped |
| `PICKUP_STOP` | `SKIPPED_REQUEST_CANCELLED` | neutral | Cancelled with its request |
| `PICKUP_STOP` | `SKIPPED_MANIFEST_CANCELLED` | neutral | Cancelled with the manifest |
| `CUSTODY_HANDOVER` | `PENDING` | waiting | Waiting for the receiver |
| `CUSTODY_HANDOVER` | `COMPLETED` | success | Custody handed over |
| `CUSTODY_HANDOVER` | `FAILED` | danger | Did not happen |
| `NOTIFICATION_ATTEMPT` | `QUEUED` | neutral | Waiting to be sent |
| `NOTIFICATION_ATTEMPT` | `LEASED` | info | Being sent |
| `NOTIFICATION_ATTEMPT` | `RETRYABLE` | waiting | Will try again |
| `NOTIFICATION_ATTEMPT` | `SENT` | info | Sent, waiting for the network |
| `NOTIFICATION_ATTEMPT` | `DELIVERED` | success | Delivered |
| `NOTIFICATION_ATTEMPT` | `FAILED` | danger | Failed |
| `NOTIFICATION_ATTEMPT` | `SUPPRESSED` | waiting | Held back |
| `NOTIFICATION_ATTEMPT` | `EXPIRED` | neutral | Too late to send |
| `NOTIFICATION_FEED` | `QUEUED` | neutral | Waiting to be sent |
| `NOTIFICATION_FEED` | `LEASED` | info | Being sent |
| `NOTIFICATION_FEED` | `RETRYABLE` | waiting | Will try again |
| `NOTIFICATION_FEED` | `SENT` | info | Sent, waiting for the network |
| `NOTIFICATION_FEED` | `DELIVERED` | success | In the feed |
| `NOTIFICATION_FEED` | `FAILED` | danger | Failed |
| `NOTIFICATION_FEED` | `SUPPRESSED` | waiting | Held back |
| `NOTIFICATION_FEED` | `EXPIRED` | neutral | Too late to send |
| `RIDER` | `ACTIVE` | success | Active |
| `RIDER` | `INACTIVE` | neutral | Inactive |
| `RIDER` | `TEMPORARILY_UNAVAILABLE` | waiting | Temporarily unavailable |
| `RIDER` | `SUSPENDED` | waiting | Suspended |
| `RIDER` | `OFFBOARDED` | neutral | Offboarded |
| `RIDER_DEVICE` | `ACTIVE` | success | Active |
| `RIDER_DEVICE` | `REVOKED` | neutral | Revoked |
| `RIDER_DEVICE` | `REPLACED` | neutral | Replaced |
| `STAFF_IDENTITY` | `PENDING_APPROVAL` | waiting | Waiting for approval |
| `STAFF_IDENTITY` | `ACTIVE` | success | Active |
| `STAFF_IDENTITY` | `REJECTED` | danger | Rejected |
| `STAFF_IDENTITY` | `SUSPENDED` | waiting | Suspended |
| `STAFF_IDENTITY` | `OFFBOARDED` | neutral | Offboarded |
| `VENDOR_ACCOUNT` | `ACTIVE` | success | Active |
| `VENDOR_ACCOUNT` | `SUSPENDED` | waiting | Suspended |
| `VENDOR_DEVICE` | `ACTIVE` | success | Active |
| `VENDOR_DEVICE` | `REVOKED` | neutral | Revoked |
| `VENDOR_DEVICE` | `REPLACED` | neutral | Replaced |


The same state name in two domains (`PENDING`, `ACTIVE`, `CANCELLED`) is two different states of two different records. The words are sentence case and plain, with no raw value and no full stop.

- **Do** write a mapping in the feature that knows the domain. **Do not** draw a status in colour alone, show the raw value of an enumeration, or put a domain value in the component.

#### CountBadge: the variants

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/count-badge/` (task C1's component, with a `variant` since 7 November 2026)

`variant` is `subtle` (the default, as it has always been: the neutral pair), `strong` (Ink with a white figure, the primary action's pair: the count of the view you are in) or `on-crimson` (white at 18% over the brand crimson, 4.63:1: a count on a crimson ground, which is what the sidebar's current entry has had by its own rule since step R4). The variant is the badge's `data-variant`; the ground it is on (`surface`: `page` or `shell`) is separate, and the sidebar passes only `surface="shell"`, so it is drawn as it was, and My work is unchanged. A `0` that was read is quiet in each (no fill, the border and the secondary text), and a count that was not given is not drawn by whoever has none to give (§24, §25). `ViewTabs` still draws its own Ink pill for the current view's count (the pair of `strong`); it moves onto `CountBadge` with its screens.

#### EmptyState v2

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/empty-state/EmptyStateV2.tsx`

The empty state redrawn (§16 is the pattern): a **10px square of the brand crimson** (decoration), a title, **one line** and an optional action, on the page with no frame. Three variants, because conflating them sends Ops hunting for a bug: `empty` (nothing yet), `filtered-empty` (something exists and the filters hide all of it: the type **requires** the action that takes the filter off) and `all-clear` (a queue worked to nothing, which is the goal: its title is in the success colour).

- **Props.** `variant`, `title`, `headingLevel?` (2, 3 or 4), `children` (the one line), `action?` (required for `filtered-empty`) and `announce?` (a polite status, set only when the empty result appears because of something that just happened, as §16 says).
- **It shows no example rows and no count.** The words are the screen's. The DataTable's `emptyState` takes it.
- **Do** use `filtered-empty` only where a filter is on. **Do not** use it for a failure (an error with a way to try again) or for what the person may not see (§15).

#### Skeleton v2 and LoadingRow

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/skeleton/` (`SkeletonBar.tsx`, `SkeletonCard.tsx`, `LoadingRow.tsx`)

Placeholders in the shape of what is on its way, so that nothing jumps when it arrives. `SkeletonBar` (`width?`, `height?`) is the part; `SkeletonCard` (`lines`, a whole number from 1 to 8, three by default; `header`, a title bar by default) has the radius, border and padding of a Panel; `LoadingRow` (`columns`, `index?`) is a row of a table with a bar in each cell, in widths that run 60, 80, 45, 70 and 55 per cent from a different start in each row, so that a block of them is not a barcode. **The DataTable draws `LoadingRow` for its loading rows**: its own bars and stylesheet were removed, so the table and the placeholder cannot differ. The bars are in `border.default` (the colour seen on a card in both themes; `surface.selected` is not), pulse only where motion is welcome and keep a border under forced colours. They are decoration, hidden from assistive technology; the words that say the page is loading are the loading indicator's (§10), as §17 says.

#### Avatar

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/avatar/`

A person's tile from the avatar primitive: the radius of the controls (`radius.md`, as the sidebar's entries and the mark have it: a tile and not a circle) at 24, 32 or 40px (`size`: `sm`, `md`, `lg`). **The fallback, which is the usual case, is the initials in `text.secondary` on `surface.selected`** (6.38:1 in the light theme; the muted text is 4.22:1 there and does not read): the first letter of the first and of the last word of the name, and the account icon when the name has no letter. A picture (`src`) is drawn once it has loaded; until then, and if it never loads, the initials stand. A picture is never required and never the only thing.

- **Props.** `name` (a string or null), `src?`, `size?` and `alone?`. Beside a name (a list, a menu) an avatar is decoration, hidden from assistive technology, so that the name is not read twice; **`alone`** gives it the role of an image named by the person ("Unknown person" when there is no name).
- **Do** write the name next to it. **Do not** use it as the only sign of who someone is.

#### Tooltip

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/tooltip/`

A hint on something that can be pointed at or focused, with **Melarc's defaults**, so that a screen never touches the primitive: it appears **300ms** after the pointer arrives and **at once** on keyboard focus, stands **8px** from what it names, floats on the one **floating shadow**, and describes what it is on to assistive technology by its words. It goes with Escape and stays while the pointer is on it (WCAG 1.4.13). Opened from inside a modal dialog it is drawn into the dialog, which it reads for itself (task R5.2, M8): a page never passes a container. It has no arrow: a shadow does not follow an arrow, and the arrow's own height would be added to the offset.

- **Props.** `content` (a string: it holds words and nothing else), `children` (one element that takes a pointer and a focus; it is not wrapped) and `side?`.
- **It names an icon or adds a hint; it never replaces the accessible name of what it is on**, and a control that can only be understood by its tooltip is not named. `IconButton` keeps the `title` that repeats its name for a pointer user (§22) and does not use this component. A disabled control takes neither a pointer nor focus, so a tooltip cannot be on one; its reason is in the control (see ActionMenu).

#### Popover

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/popover/`

A small panel that opens under what opened it, with Melarc's defaults: **8px** away, on the **floating shadow**, a dialog **named by `label`**, Escape to close it and focus returned to what opened it. Props: `trigger` (one element; it is not wrapped), `label`, `children`, `open?` and `onOpenChange?` (controlled use), `align?`, `side?`, `container?` (the element it is drawn into: inside a modal dialog it is drawn into the dialog, or it would open under it, as the date field's calendar does), `onOpenAutoFocus?`, `contentRef?` (a reference to the panel's own element, for a caller that has to tell a blur inside from a blur outside) and `className?`. These are the props that the date field and the filter bar use from the primitive today, so that they can move onto this component without changing; **the filter bar now uses this component** (task R5.2, M8, M12) and the date field still uses the primitive. The container is read from the dialog the popover is in (`DialogContainer`), so no page passes one, and the popover keeps 8px from the edges of the window. Both stand 4px from what opens them today, so moving them onto this component makes it the 8px default (a visible change of 4px, which the move should own).

- **Do** use it for a choice or a few controls. **Do not** put in it a decision that must not be missed (that is a dialog) or the only way to do something.

#### The four page templates

> **Status:** IMPLEMENTING · **Code:** `apps/ops-web/src/components/ui/templates/`

**Redesign step R6, 8 November 2026** ([PRODUCT_DESIGN_DIRECTION §6](PRODUCT_DESIGN_DIRECTION.md#6-the-four-page-templates)): `QueueWorkspace`, `RecordPage`, `TaskForm` and `Builder`, each in the showcase (`/__showcase/kit/example-queue`, `example-record`, `example-form`, `example-builder`) and proven in jsdom and in a browser (WCAG 2.2 in both themes, 320px, 200% text, forced colours). **A template is layout, states and behaviour composed from the kit, and never data or a business rule:** a page passes in what a row is, what a view counts, which acts the session can take and the words of a refusal, and the server decides everything. **A count, a total or an estimate on a template is the server's**, and a figure that was not given is not drawn (never as 0). No screen uses a template until Stage 6 of the run that built them moves four real screens (the pickup queue, a pickup request, booking a pickup and building a manifest); until the Product Owner has accepted them none is ACTIVE.

##### QueueWorkspace

*Work to be done or watched* ([§6.1](PRODUCT_DESIGN_DIRECTION.md#61-queue-workspace)).

- **Composes**, in this order: `PageHeader` (title, the server's count, the freshness line, the page's actions), `ViewTabs` with counts, `FilterBar`, `DataTable` and, beside the table, `SidePanel` for the open record. The views and the filters are optional.
- **Props.** `header` (`PageHeaderProps`), `views?`, `filters?` (`FilterBarProps`), `notice?`, `result` (`loading`, `error` with `message` and `onRetry`, or `ready` with `rows`, `stale?` and `refreshing?`), `empty` (the words of the three kinds of nothing), `emptyState?` (the page's own state in their place), `table` (the `DataTable` configuration but for its states), `panel?` (`SidePanelProps`) and `ref` (`QueueWorkspaceHandle`, the table's: `focusRow(id)`, `focusResults()`). **`refreshing`** keeps the rows while they are read again after an act (a confirmation, a decision): they stay in place with the person's focus and the row that changed (`table.changedIds`), and the table says it is busy; a page that must not show rows as if they answered the read says `loading`. The panel stays in view **below the top bar** and is bounded to the window below it, scrolling inside itself under its header.
- **Carried from the kit, so that a page does not wire it again.** Column priority (opening the panel narrows the table's own box, so the columns the page marked lesser go and the table never scrolls sideways at 1440px); the bar of acts above the rows with its eligible-only acts; cards at 390px; the place the officer left and the row they came from (`table.initialScroll`, `table.onScrollChange`, `table.focusRowId`); the panel becoming a full-screen sheet at 768px and below; a footer for the pager (`table.footer`).
- **States, each in the page's words.** *Loading*: rows of the table's own shape. *Nothing yet*: "No pickup requests yet" and the line the page gave. *Nothing that fits the filters*: "No pickup requests match", with **the page's own words** under it (`filteredText`, required) and the page's own button (`clearLabel`, required) so that the sentence and the button say the same thing ("Nothing fits these filters. Show every request to start again."); the template holds no words of its own for it. *Nothing at the chosen hub*: **a chosen hub is a filter**, so "Nothing at Accra Central" with *Show all hubs* (and the way to take the page's filters off beside it when they are set too); never "No requests yet". *Failure*: the page's message with *Retry*; a refusal is worded as [PRODUCT_DESIGN_DIRECTION §6.5](PRODUCT_DESIGN_DIRECTION.md#65-on-screen-language) says, never a key or a role. *Stale*: the last rows stay under a line that says so, with the way to read again.
- **The pager.** `QueuePager` (in the same folder) is what follows the table of a paged queue, as `table.footer`: a line that says how many rows the page shows and never a total ("Showing 2 requests. More follow on the next page."), in a region that is in the page **empty on the first paint, with the words written into it afterwards** (a region that arrives with its words is not announced by most screen readers), and "Previous page" and "Next page" when there are any. The page keeps the tokens (`useQueuePaging`) and draws the pager only for rows that answer the read.
- **A way out that is not a retry.** `result.retryLabel` names the button of a failure that asking again would not mend ("Back to first page" for a saved page the server will not open); it defaults to "Retry".
- **Focus back to the row.** The template remembers the row the panel was opened from and, when the panel closes, gives focus to that row's control **as it is drawn now** (the table and its cards swap when the panel narrows the room), and puts it back once the layout has settled if the swap dropped it.
- **The first screen on it is the pickup queue (R6.1):** the views are the states a request moves through (no count: the server states none), the filter row holds the service date and the late bookings as chips, the row act is *Confirm* (a question first, then the version of that one request is read and the request confirmed with it), **there is no bulk act** (confirming takes one request's version and the API has no bulk path), and a request opens in the panel with its summary and its primary act, with "Open full page" leaving the place the officer will come back to.
- **Do** keep the filters, the order, the scroll and the chosen rows in the page, in the address or in memory as the screen decides, and open a record in the panel with "Open full page". **Do not** work out a count, a total or a bulk act's eligibility in the template, offer a bulk act that is not safe and atomic, or draw an act the session cannot take.

##### RecordPage

*One thing and its history* ([§6.2](PRODUCT_DESIGN_DIRECTION.md#62-record)).

- **Composes** the breadcrumb, `RecordHeader` (the code is the page's one level-one heading, with the status, one sentence, the stages, **one** primary action, the other acts and the `ActionMenu`) in a page card, a main column for the work and the activity (`Timeline` in a `Panel`), and a side column for facts, people and related records (the page's `Panel`s).
- **Props.** `breadcrumb?`, `header` (`code`, `status?`, `sentence?`, `stages?`), `acts?` (`primary?`, `secondary?`, `menu?: { label, items }`), `conflict?` (`onReload`, `message?`), `notice?`, `main`, `side?`, `activity?`.
- **Acts.** Only an act the session can take is passed in: hiding is presentation and never enforcement, and the server refuses what is not allowed. A menu with no item is not drawn. The heavier acts are in the menu, destructive ones last and always confirmed ([`ActionMenu`](#actionmenu)).
- **A version conflict** is a banner (`Alert`, announced) with *Reload*, above the record: "This record changed since you opened it. Reload to see the latest version."
- **The same composition renders in a `SidePanel`.** There the panel's heading is the code and its header carries the status and "Open full page", so the breadcrumb, the page card and the code go; the sentence, the stages and the acts stay, the columns become one (the work, the activity, then the side), and the activity panel's heading is level three.
- **Columns.** Two thirds and one third where the page's own room has 60rem; one column below, with the side after the work. Every template reads its room with a **container query**, never the window's width: a media query's `rem` is the browser's own, so it does not see text enlarged through the root's size, and a form beside a rail would be crushed at 200% text.
- **The first screen on it is a pickup request (R6.2, `/pickup-requests/:id`):** the header carries the code, the state as a badge, one sentence (the state in words, and the escalation's date), the one primary act (*Confirm the pickup*, *Decide the late booking*, *Request the exception* or *Waive the charge*, whichever the state and the session's keys allow, and none when none does), a secondary link for an approver, and the menu (*Reschedule*, *Escalate*, *Extend the attempts* and, last and destructive, *Cancel the request*, each bringing its own question or form and giving focus back to the menu's button); the body holds the facts grouped by what they mean (the pickup; who to reach and who pays; the exceptions; the history), the estimate and the attempt chain; **an act the session cannot take is not drawn and no refusal names a key**; the way back is the same element while the request loads and after it; and there is **no stage tracker**, because the request's states are four and a path through dispatch and collection is not what its read carries.
- **Do** put a record's own facts in `Panel`s of the right heading level (2 on a page, 3 in a panel). **Do not** draw two primary actions, a stage the server did not state, or a phone number masked on a record's own page (masking is for lookup results; [DescriptionList](#descriptionlist)).

##### TaskForm

*Creating or completing a unit of work* ([§6.3](PRODUCT_DESIGN_DIRECTION.md#63-task-form)).

- **Composes** the page header, sections (`TaskFormSection`: a level-two heading, an optional one-line rule, a field grid; `TaskFormWide` for a field that takes the row), the sticky summary rail, an optional review, the form's actions and the guard against leaving.
- **Props.** `header` (`title`, `description?`, `breadcrumb?`), `alerts?`, `children` (the sections), `summary?` (`title?`, `children`), `review?` (`active`, `children`, `onBack`, `backLabel?`, `title?`), `actions`, `dirty?`, `busy?`, `onSubmit`, `formRef?`.
- **The grid** is two columns on a desk and one at 768px and below, each field as wide as its content. **The rail** shows what the server states (an estimate, a cut-off, a window, a fee, a limit) in the server's words and numbers, beside the sections where the page's own room has 60rem (sticking below the top bar) and after them below; a rule that changes a choice also sits beside the choice, in one line.
- **The review** is shown in place of the sections (which stay in the page, hidden, so nothing entered is lost) with a way back: what will be created or changed and what the server decides. It is a review, not a second form.
- **Validation is inline and the page's.** The form is `noValidate`; the page checks the fields, tells each its own error and focuses the first.
- **Success** is `announceTaskDone`: a toast with **Open** (the thing made) and a way to do another, in the screen's own words ("Book another"); a toast raised while a dialog is open is held until it has closed, and a toast with an action stays until it is dismissed ([Toast](#toast)).
- **Leaving with unsaved changes** asks (`UnsavedChangesGuard`): the application's own navigation is held by the router's blocker and answered by an `AlertDialog` whose safe answer, "Stay here", is first; a reload or a closed tab gets the browser's own warning. The page says `dirty`, and turns it off once the task is sent.
- **The first screen on it is booking a pickup (R6.3, `/pickup-requests/new`):** what is being booked comes first and decides which sections follow (the vendor, where the parcels are, where the parcel is collected from and goes, where it is booked, the sender, when and how many, who pays, the declared value); a field takes half a row beside the next and a group of choices, a picker or a note takes the row; the rail ("After you book") says what the booking comes to and works out nothing (no price, no estimate: the server's indicative estimate comes with the booking it makes); leaving after anything was entered asks first; and **the success is not a toast**: the server's estimate and the note for a single package must stay on the page, so the booked view keeps its estimate and its two acts (*View the request*, *Book another pickup*) and `announceTaskDone` is not used here. There is no review step, as the screen had none.
- **Do** order the sections as the officer thinks of the task and ask only what the task needs. **Do not** make the review a second form, check a field in the template, or word a success before the server's answer.

##### Builder

*Putting a run together from a pool* ([§6.4](PRODUCT_DESIGN_DIRECTION.md#64-builder)), the pickup run and the delivery run.

- **Composes** the page header, the run's own fields (`setup`: the hub and the day), and two panes: the **pool** (`title`, `description?`, `toolbar?`, the rows: a `DataTable` with a box on each) and the **run** (what was chosen, in order, its totals and its actions). Where the page's own room has 60rem the run (24rem) stays in view beside the pool, **below the top bar and bounded to the window below it: its card is a column whose body scrolls inside it and whose actions stay at its foot, so that the one Create and the reasons of a carried-over request are always in reach**; below that, the hub-floor tablet at 768px among it, the panes are one column, the pool first, and a button in the pool's header goes to the run and puts focus on its heading.
- **Props.** `header`, `alerts?`, `setup?`, `panes?` (`pool`, `run`: `title`, `summary`, `totals?`, `children`, `actions`), `note?` (said in place of the panes while there is no hub), `dirty?`, `busy?`, `onSubmit`, `formRef?`, `outside?` (dialogs, which stay outside the form so that their own submit never reaches the build's).
- **One hub per build.** The run is for one hub and the pool is that hub's; changing the hub is the page's question, asked before the choice is cleared.
- **`BuilderRunList`**: the rows chosen, in order, each with `refusal?` and `stale?` **on the row it names**, in words with an icon (never colour alone), linked to the row as its description. **A refusal is shown on its row and the row stays; a stale row is flagged and never dropped silently.** A remove button names the row it takes out. A refusal that names no row is the page's banner (`alerts`).
- **The totals** are the server's, as facts (`DescriptionList`): one that was not stated says so in words and is never drawn as 0. The `summary` is the page's count of its own choice ("3 requests chosen"), in a live region.
- **The first screen on it is building a manifest (R6.4, `/manifests/new`):** the hub of the run and its day are the `setup` (the hub asked for, after a question, when requests are chosen); the pool is the confirmed pickups no manifest holds, in a `DataTable` with a box on each row, paged by the server's tokens (`QueuePager`), whose choice is kept across the pages; the run is *Review*: what was chosen, in the order chosen, each with its own remove button and **the server's refusal on the row it names**, the reason and note each overdue request asks for, and the actions (*Create the manifest*, or *Reload the pool* and *Try again* after an answer that was lost, and *Cancel*); the page follows the made manifest only after the leave guard is off. The page keeps no mark of a **stale** row of its own: it does not compare the pool with the choice (an extra read), and the refusal of the server is what marks a request that moved.
- **Do** keep the order, the hub and the stale marks in the page and let the server accept or refuse the run. **Do not** drop a row the server changed, compute a total, or choose a row of another hub.

#### Dialog and AlertDialog: reused, with the Melarc defaults

> **Status:** the `Dialog` and `AlertDialog` of §20 stay ACTIVE · **Code:** `apps/ops-web/src/components/ui/dialog/` (the motion was added to `dialog.css` on 7 November 2026, afternoon; the components and their props are as they were)

The Product Owner accepted, on 7 November 2026 (afternoon), that pages keep using Melarc's own wrappers of the modal dialog and that no second modal is built on the `dialog` primitive, **provided they carry the Melarc defaults**. They were checked against the list below, in a real browser, in each of the two (`test/browser/dialogs.spec.ts`: it reads the computed style and the starts of the animations, and compares each with its token). What they carry, and what had to be added:

| Default | What they carry | What shows it |
|---|---|---|
| Surface | `surface.default` with the strong border (`border.strong`): the recipe of the `dialog` primitive's panel | the computed background and border colour, each equal to its token |
| Corners | `radius.lg`, 12px | the computed radius, equal to the token |
| Elevation | the one soft shadow of a thing that floats, `shadow.floating` ([DESIGN_SYSTEM §8](DESIGN_SYSTEM.md#8-elevation)) | the computed shadow, equal to the token |
| Scrim | `surface.inverse` at 55%, fading in with the panel | the scrim's opacity once it has arrived |
| Motion in (**added**: they had none) | in over `motion.normal` (200ms) on `motion.easeEnter`, fading and growing from 95%, with the scrim fading in beside it, as the `dialog` primitive's panel does ([DESIGN_SYSTEM §9](DESIGN_SYSTEM.md#9-motion)) | the starts of the animations: the panel's and the scrim's, each with the duration and the easing of its token |
| Reduced motion (**added**) | nothing animates: the animation is switched off, and not only given no time (an animation of no time still sends its events) | no start of an animation at all, and the animation name `none` |

`AlertDialog`, `ConfirmationDialog` (§20.4) and `ReasonConfirmationDialog` (§20.3) are all `Dialog` inside, so the one stylesheet, `dialog.css`, gives every one of them these defaults; no other stylesheet styles the panel (the date field's only rule lets a calendar overhang it).

**The duration is `motion.normal`, not `motion.slow`.** §9 gives `slow` (280ms) to the record panel and to sheets, which come in from an edge and cover a part of the page; a dialog is a panel that appears in the middle, as a menu or a popover does, and the `dialog` and `alert-dialog` primitives (step R3) already use `normal`. One token in `dialog.css` changes it.

**Not carried: the way out.** The primitives leave over `motion.normal` on `motion.easeExit`; these two do not, because a native `<dialog>` is closed by the platform in the commit in which the page says it is closed, and its content is removed in the same commit. Giving them an exit means keeping the content, as it was last drawn, for the length of the exit after the page has closed the dialog, and drawing it as it left with a transition that the browser holds the dialog's place for (`overlay` and `display`, which only some engines support), so that nothing the page does with the focus or with what lies behind it changes in the meantime; that touches how every screen that has a dialog closes, and it was not done. **The alternative the Product Owner may choose:** an exit of 200ms for the engines that can draw it, at the cost of that change and of its proof in each screen's browser tests. Until then a dialog comes in with the default motion and goes at once.

The command palette keeps the `dialog` primitive it was built on in step R4. The showcase (`/__showcase/kit/overlays`) draws both wrappers and a popover opened inside a dialog, which is the case the `container` prop is for.

**What the second half leaves unbuilt, and why.** *No screen was moved:* `EmptyState` (§16) and `Skeleton` (§17) stay what the pages draw; the date field's calendar, the filter bar's popover and the sidebar rail's tooltips still use the popover and tooltip primitives with their own settings (300ms and 8px are the new components', not theirs); `ViewTabs` still draws its own pill; `DescriptionList` and `StatTile` still draw a placeholder bar of their own while they load (the same look as `SkeletonBar`); and the mappings of the pages still say `warning` for the pair this table calls `waiting`. These belong to the screens' steps (R6 and R7), where each is a mechanical change. *Not built at all:* a picture of a person (the portal holds none, so `src` has no caller), a group of overlapping avatars, a tooltip with more than words, an arrow on a popover or a tooltip, and a second modal dialog (above).


### The primitives of redesign step R3

Step R3 (5 November 2026) installed 24 shadcn/ui primitives in `apps/ops-web/src/components/primitives/` ([DESIGN_SYSTEM §29.2](DESIGN_SYSTEM.md#292-the-component-foundation)): alert dialog, avatar, badge, breadcrumb, button, calendar, card, checkbox, command, dialog, dropdown menu, input, label, popover, scroll area, select, separator, sheet, skeleton, sonner (the toaster), table, tabs, textarea and tooltip. They are **not Melarc components**: no page imports one, and none is a pattern of this file until a component of `components/ui` composes it, a screen uses that component and the Product Owner accepts it (§2). Each is drawn in the showcase (§27), in both themes, with its overlays driven from the keyboard in a real browser. The components of the kit above are composed from them: those of the shell in redesign step R4 (seven primitives: `badge`, `button`, `command`, `dialog`, `dropdown-menu`, `sheet` and `tooltip`), the rest in step R5. The native components that are ACTIVE (Button, Input, Textarea, Checkbox, Select, Table, Dialog, AlertDialog, Skeleton and StatusBadge) are not replaced by their primitives now: an active pattern is not silently replaced (§2), and whether step R5 recomposes any of them is decided there and recorded here.

### Phasing out React Aria Components

**Done (Product Owner's decision of 6 November 2026, redesign step R5).** React Aria Components was the library for behaviour that no native element gives ([DESIGN_SYSTEM §24a](DESIGN_SYSTEM.md#24a-interaction-primitives)); on 5 November 2026 the shadcn/ui primitives replaced it for new components, and the two components still built on it moved on 6 November 2026. **It is removed**: nothing imports it, and the packages `react-aria-components` and `@internationalized/date` (and what they brought: `react-aria`, `react-stately`, the `@react-aria`, `@react-stately`, `@react-types` and `@internationalized` families, `@swc/helpers`, `use-sync-external-store` and `client-only`) are no longer dependencies. What left with them, as the plan of 5 November listed: their door (the React Aria lines of `eslint.config.mjs`, which now hold the Motion door, and `test/aria-door.test.ts`); `test/aria-licences.test.ts` and the three licence files only they needed (`React-Aria-Apache-2.0.txt`, `swc-helpers-Apache-2.0.txt` and `use-sync-external-store-MIT.txt`; `clsx-MIT.txt` and `aria-hidden-MIT.txt` are the shadcn/ui set's too, and stay); the `react-aria-pressable-style` meta of `index.html`, its rule in `base.css` and `src/components/ui/aria-wiring.test.tsx`. The date field keeps its public API and is on the calendar and popover primitives (§22a).

| Melarc component | React Aria parts it was built on | Replaced by | Done |
|---|---|---|---|
| DatePicker (§22a): the calendar that opens under the field | `Calendar`, `CalendarGrid`, `CalendarCell`, `Heading`, `Popover`, `Dialog` and `Button` | the `calendar` primitive (react-day-picker, which starts the week on Monday in English as written in the United Kingdom) in a `popover` | **DONE**, 6 November 2026 |
| DatePicker (§22a): the typed day, month and year | `DateInput`, `DateSegment`, `Group` and `I18nProvider`; `@internationalized/date` | **one text field typed as DD/MM/YYYY, read strictly** (`date-picker/day-first.ts`), the Product Owner's decision of 6 November 2026 on the question this table left open: the registry has no entry of a date as three typed parts | **DONE**, 6 November 2026 |

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
| AuthenticatedOpsShell, Sidebar and TopBar | IMPLEMENTING | The first form was ACTIVE (S0.42); the sidebar and the top bar of redesign step R4 (7 November 2026) replaced it and are built, in the showcase (`/__showcase/shell`) and drawn by every signed-in screen. ACTIVE once the Product Owner accepts them (§2). The components §37 lists with them have the next row |
| CommandPalette and SearchButton, NewMenu, AccountMenu, HubSwitcher | IMPLEMENTING | Redesign step R4 (7 November 2026): built (`components/ui/app-shell/`), drawn by every signed-in screen, and awaiting the Product Owner's acceptance with the shell (§2) |
| Icon, IconButton | ACTIVE | 25 October 2026 |
| DatePicker | IMPLEMENTING | 28 October 2026: built, proven in the showcase and reviewed ([the plan's §7.50](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026)); the pickup screens use it since S1.19 (29 October 2026), and its look awaits the Product Owner. **Rebuilt on 6 November 2026** (redesign step R5) on the calendar and popover primitives behind the same public API, as one field typed DD/MM/YYYY and read strictly: a day that its month does not have and a year in fewer than four digits are refused in words, and nothing is corrected (the Product Owner's decision of 7 November 2026; the previous field's silent corrections were the alternative rejected, §22a); React Aria Components is removed (§22a, §37) |
| RadioGroup, Picker, MoneyAmount, Timeline, QueueTable | IMPLEMENTING | Pickup intake (S1.19, 29 October 2026): built, in the showcase, used by the pickup screens (§22b to §22f) |
| QueueTable row selection, ReorderList, RiderPicker | IMPLEMENTING | Manifests and runs (S1.25, 3 November 2026): built, in the showcase (the rider picker as the Picker over demo riders), used by the manifest screens (§22f, §22g, §22h) |
| Split screen (`AuthSplitLayout`, `AuthArt`) | ACTIVE | 25 October 2026 |
| ErrorState | ACTIVE | Yes |
| NotFoundState | ACTIVE | Yes |
| CountBadge | IMPLEMENTING | Task C1 (5 November 2026): built, used by the sidebar's entries since redesign step R4 (My work draws the figures of its cards in its own face, not with this component), proven in jsdom and in a browser in both themes. Its variants `subtle`, `strong` and `on-crimson` were added in the second half of redesign step R5 (7 November 2026; the sidebar and My work are drawn as they were). ACTIVE once the Product Owner accepts it with the shell (§2) |
| ForbiddenState, EmptyState, Skeleton, StatusBadge, Table | ACTIVE | Identity implementation (S0.40) |
| Select, Dialog, AlertDialog, reason and confirmation | ACTIVE | Identity implementation (S0.41) |
| Button `danger` | ACTIVE | Identity implementation (S0.41) |
| FormPage, the five pre-sign-in screens | ACTIVE | Identity implementation (S0.43) |
| ButtonLink, ConfirmationDialog, the six signed-in identity screens | ACTIVE | Identity implementation (S0.44) |
| The shadcn/ui primitives of `components/primitives` (24, DESIGN_SYSTEM §29.2) | IMPLEMENTING | Redesign step R3 (5 November 2026): installed and restyled, drawn in the showcase and driven from the keyboard in a browser. Seven are composed by components of redesign step R4 (`badge`, `button`, `command`, `dialog`, `dropdown-menu`, `sheet` and `tooltip`, in `components/ui/app-shell/` and `components/ui/count-badge/`), so every signed-in screen draws them; no screen imports one directly, and the Product Owner has not yet accepted them |
| PageHeader (the redesign's), ViewTabs, FilterBar, DataTable, SidePanel, RecordHeader with StageTracker, ActionMenu, DescriptionList, Panel and Card, StatTile, Toast (§37, *the kit as built*), and Motion | IMPLEMENTING | Redesign step R5, first half (6 November 2026): in `components/ui`, in the showcase (`/__showcase/kit`) with every variant and state in both themes, proven in jsdom and in a browser (WCAG 2.2 in both themes, the keyboard, reduced motion, the strict policy). No screen uses one yet and the Product Owner has not yet accepted them, so none is ACTIVE |
| The rest of the planned kit of §37: StatusBadge v2 (five pairs, the dot and the one table of statuses), CountBadge's variants, EmptyState v2, Skeleton v2 with LoadingRow, Avatar, Tooltip and Popover (§37, *the kit as built, second half*) | IMPLEMENTING | Redesign step R5, second half (7 November 2026): in `components/ui`, in the showcase (`/__showcase/kit/badges`, `states` and `overlays`) with every variant and state in both themes, proven in jsdom and in a browser (WCAG 2.2 in both themes, the keyboard, reduced motion, the strict policy). StatusBadge's look is drawn wherever the badge was, and the DataTable draws `LoadingRow`; no page was otherwise moved, and `EmptyState` (§16) and `Skeleton` (§17) stay ACTIVE until their screens migrate. The Product Owner has not yet accepted them, so none is ACTIVE |
| The four page templates: QueueWorkspace, RecordPage, TaskForm, Builder (§37, *the four page templates*) | IMPLEMENTING | Redesign step R6 (8 November 2026): in `components/ui/templates`, in the showcase (`/__showcase/kit/example-queue`, `example-record`, `example-form` and `example-builder`), proven in jsdom and in a browser (WCAG 2.2 in both themes, 320px, 200% text, forced colours). No screen uses one until the proof screens of the same run move onto them, and the Product Owner has not accepted them, so none is ACTIVE |
| The Dialog wrapper | ACTIVE | It is the `Dialog` and `AlertDialog` of §20 (Identity implementation, S0.41); their motion (in, and nothing under reduced motion) was added on 7 November 2026, afternoon, and the defaults they carry are listed in §37 |

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
| Navigation for the authenticated shell | `components/PrimaryNavigation.tsx` (a plain list; renders nothing when empty; not used by the neutral frame). **Removed in redesign step R4**, with its test: the `Sidebar` of `components/ui/app-shell/` is the navigation now (§12.6) | **Retained** for the shell then; replaced in step R4 | `components/ui/app-shell/Sidebar.test.tsx` |
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
provides the caller's capabilities yet (DESIGN_SYSTEM §22). (That was the state of 6 October 2026: the identity slice then built
the shell, and redesign step R4 replaced it and removed `PrimaryNavigation`, §12.6.)

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
| Session guards | `platform/session/` | `RequireSession` (loading, sign-in redirect that replaces the entry, or an error with an explicit retry) and `RequirePermission` (a refusal that says what the account cannot do in plain words, never the permission key and never a role). The full ForbiddenState (§15) is S0.40's |

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
| AuthenticatedOpsShell, the route registry | `app/AuthenticatedOpsShell.tsx`, `app/navigation/route-registry.tsx` | §12.6. Built as a band across the top (`ShellBar`); replaced on 25 October 2026 by the side menu (§42.8), and by the sidebar and the top bar in redesign step R4 (§12.6) |

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
| The six screens | `app/pages/staff/` (`StaffListPage`, `StaffCreatePage`, `StaffDetailPage`, `StaffMfaResetPage`, `SessionsPage`) and the landing, My work (`app/pages/my-work/`), routes in `app/navigation/route-registry.tsx` | §12.8. The registry has a `description` (what a page is for), which finds the page in the command palette |
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
| SideMenu | `components/side-menu/` (removed in redesign step R4: the `Sidebar` of `components/ui/app-shell/` replaced it, §12.6) | Collapses to a rail, slides in on a narrow screen with the main content inert, scrolls as a whole when the window is too short; the collapse state is in memory only |
| PrimaryNavigation | `components/PrimaryNavigation.tsx` (removed in redesign step R4, with the `Sidebar`, §12.6) | A vertical list of an icon and a label; the current entry is a filled item with `aria-current`; a `title` when the menu is collapsed |
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
Seven of them are composed by the components of redesign step R4 (§37, §12.6).

| Pattern | Built as | Notes and differences from the plan above |
|---|---|---|
| The primitives | `components/primitives/` (24 files) | §37. Generated source from the official shadcn registry, restyled through the tokens, one door to Radix UI and the libraries beside it (DESIGN_SYSTEM §29.2, §29.6 for where they differ from the registry's source) |
| `cn`, `useResolvedTheme` | `lib/utils.ts`, `platform/theme/use-resolved-theme.ts` | The one way class names are joined; the theme that applies (the root's `data-theme`, then the system's setting), for what a library must be told in a prop |
| The showcase of the primitives | `showcase/PrimitivesShowcase.tsx`, `showcase/TablePrimitiveDemo.tsx` | §27. Every primitive in both themes, in Melarc's words, and the table primitive alone (caption, state badges, a box to choose a row with). The data table with sorting and a row model is the kit's `DataTable`, the one importer of TanStack Table (§37, the door; task R5.2) |
| The banner's logo | `app/AppFrame.tsx` | The primary logo on a light ground and the all-white lockup on a dark one, chosen by `useResolvedTheme`: one image that carries the name once (DESIGN_SYSTEM §31) |

---

**End of Melarc Component Patterns v1.1**
