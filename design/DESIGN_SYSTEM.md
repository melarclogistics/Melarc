# Melarc Design System

> **Status:** ACTIVE DESIGN BASELINE — grounded in the approved Melarc Brand Foundation; approved by the Product Owner on 6 October 2026  
> **Version:** 1.2  
> **Date:** 5 October 2026; revised 6 October 2026 to reconcile it with the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md) (§4.6, §11, §13.1, §14, §22, §24–§26, §29, §36)  
> **Repository path:** `design/DESIGN_SYSTEM.md`  
> **Depends on:** `design/BRAND_FOUNDATION.md`  
> **Owns:** semantic design tokens, accessibility rules, typography scale, spacing, radius, elevation, focus treatment, responsive behavior, density, UI state presentation, token naming, the web UI library policy (§23, §24a), and the initial UI-foundation implementation scope  
> **Does not own:** product workflows, business rules, API behavior, domain state semantics, logo source artwork, or speculative component APIs

---

**Approval (Product Owner, 6 October 2026).** This document is approved and its values are active. Where the text still says
"proposed" or "provisional" about a value (the inverse focus and link recipes, the interface crimson and ink, the palette,
the spacing, breakpoints and focus ring), that approval settles it. What stays open is only what §36 shows as OPEN, NOT
DECIDED, DEFERRED, NOT STARTED or NOT YET FINAL. A change to an approved value is a foundation change (§34) made here, in
the same commit as the token file.

---

## 1. Purpose

This document converts the Melarc Brand Foundation into an implementation-ready product design system.

Its purpose is to ensure that the Ops Portal, Vendor PWA, Rider Android application, and future Melarc interfaces share:

- one visual language;
- one semantic color system;
- one typography hierarchy;
- one spacing and density philosophy;
- one accessibility baseline;
- one responsive strategy;
- one set of UI-state meanings.

The system is intentionally **platform-aware rather than visually identical across platforms**.

The web applications may share implementation packages. Rider Android should use native Android components while mapping to the same semantic design foundations.

---

## 2. Design principles

Every Melarc interface should follow these principles.

### 2.1 Clarity before decoration

Operational meaning comes first.

Use hierarchy, spacing, typography, labels, and state presentation before decorative treatment.

### 2.2 Restraint communicates quality

Premium does not mean ornamental.

Prefer:

- disciplined alignment;
- restrained color;
- consistent spacing;
- precise copy;
- strong interaction states;
- subtle depth.

Avoid:

- visual effects used without purpose;
- excessive red;
- excessive card nesting;
- gratuitous animation;
- decorative gradients;
- excessive pill-shaped UI.

### 2.3 Density follows the task

Melarc does not use one global density.

- navigation and page composition are spacious;
- normal forms are balanced;
- operational tables and repeated data rows are efficient;
- touch interfaces remain comfortably tappable.

### 2.4 Accessibility is foundational

Accessibility is not a later cleanup phase.

The design system must make correct contrast, focus, labeling, target sizing, and state communication the default.

### 2.5 Semantic tokens over raw values

Product code should consume semantic meaning:

```text
color.action.primary
color.text.primary
color.status.warning.foreground
color.border.control
```

rather than raw values such as:

```text
#B4232E
#172033
```

### 2.6 Platform conventions matter

A web interface should behave like a good web application.

A native Android application should behave like a good Android application.

Brand consistency does not justify breaking platform expectations.

---

## 3. Token architecture

Melarc uses three token layers.

```text
Primitive tokens
        ↓
Semantic tokens
        ↓
Component tokens
```

### 3.1 Primitive tokens

Raw design values.

Examples:

```text
crimson.700
ink.950
gray.50
space.4
radius.md
shadow.sm
```

Primitive tokens should rarely be consumed directly by feature code.

### 3.2 Semantic tokens

Meaningful application-level values.

Examples:

```text
color.action.primary
color.text.muted
color.surface.page
color.border.control
color.status.success.foreground
focus.ring
```

Feature and component implementation should prefer semantic tokens.

### 3.3 Component tokens

Component-specific aliases introduced only when a real component requires them.

Examples:

```text
button.primary.background
input.border.default
sidebar.item.active
table.row.hover
```

Do not create hundreds of component tokens before components exist.

---

## 4. Color system

## 4.1 Brand relationship

The current supplied logo uses approximately:

- logo red: `#BE1E2D`;
- logo black: `#000000`.

These are **logo reference values** only until verified against the original vector artwork.

The application interface uses a related but distinct Crimson + Ink palette.

The logo must not be recolored merely to match interface tokens.

---

## 4.2 Primitive color palette

### Crimson

| Token | Value | Usage |
|---|---:|---|
| `crimson.50` | `#FFF4F5` | very soft brand tint |
| `crimson.100` | `#FCEBED` | soft selected/accent surface |
| `crimson.200` | `#F7CDD2` | decorative accent/border |
| `crimson.300` | `#EDA3AC` | restrained accent |
| `crimson.500` | `#C93D4A` | supporting brand emphasis |
| `crimson.600` | `#B4232E` | primary brand/action |
| `crimson.700` | `#971B26` | primary hover/pressed |
| `crimson.800` | `#7D1720` | strong brand text where appropriate |
| `crimson.900` | `#65131B` | darkest brand tone |

### Ink / neutral

| Token | Value |
|---|---:|
| `ink.950` | `#172033` |
| `gray.900` | `#1F2937` |
| `gray.800` | `#344054` |
| `gray.700` | `#475467` |
| `gray.600` | `#667085` |
| `gray.550` | `#7C879B` |
| `gray.500` | `#8A94A6` |
| `gray.400` | `#98A2B3` |
| `gray.300` | `#D0D5DD` |
| `gray.200` | `#DDE1E7` |
| `gray.100` | `#EAECF0` |
| `gray.50` | `#F7F8FA` |
| `white` | `#FFFFFF` |
| `black` | `#000000` |

### Supporting semantic hues

| Role | Base | Strong text | Soft background |
|---|---:|---:|---:|
| Success | `#157A55` | `#0F5D42` | `#E8F6F0` |
| Warning | `#B76E00` | `#8A5200` | `#FFF4E5` |
| Danger | `#B4232E` | `#8F1D27` | `#FCEBED` |
| Info | `#2563A6` | `#1F4F86` | `#EAF2FB` |

---

## 4.3 Core semantic color tokens

### Surfaces

| Token | Value |
|---|---:|
| `color.surface.page` | `#F7F8FA` |
| `color.surface.default` | `#FFFFFF` |
| `color.surface.subtle` | `#F2F4F7` |
| `color.surface.inverse` | `#172033` |
| `color.surface.selected` | `#FCEBED` |
| `color.surface.disabled` | `#F2F4F7` |

### Text

| Token | Value |
|---|---:|
| `color.text.primary` | `#172033` |
| `color.text.secondary` | `#475467` |
| `color.text.muted` | `#667085` |
| `color.text.disabled` | `#98A2B3` |
| `color.text.inverse` | `#FFFFFF` |
| `color.text.link` | `#971B26` |
| `color.text.linkHover` | `#7D1720` |

### Borders

| Token | Value | Rule |
|---|---:|---|
| `color.border.subtle` | `#DDE1E7` | decorative separators only |
| `color.border.default` | `#D0D5DD` | normal structural borders |
| `color.border.control` | `#7C879B` | control boundary where border is visually required (`gray.550`; 3:1 on every light surface of §4.6) |
| `color.border.strong` | `#667085` | high-emphasis boundary |
| `color.border.disabled` | `#DDE1E7` | disabled treatment |

`color.border.subtle` must not be the sole required visual boundary of an input or interactive control.

### Actions

| Token | Value |
|---|---:|
| `color.action.primary` | `#B4232E` |
| `color.action.primaryHover` | `#971B26` |
| `color.action.primaryPressed` | `#7D1720` |
| `color.action.primaryText` | `#FFFFFF` |
| `color.action.secondary` | `#FFFFFF` |
| `color.action.secondaryText` | `#172033` |
| `color.action.disabled` | `#EAECF0` |
| `color.action.disabledText` | `#98A2B3` |

### Focus

| Token | Value |
|---|---:|
| `focus.ring` | `#2563A6` |
| `focus.offset` | `#FFFFFF` |
| `focus.width` | `2px` |
| `focus.offsetWidth` | `2px` |

Focus styling must be visible without depending on hover.

Do not remove browser focus treatment unless an equal or stronger custom focus indicator replaces it.

---

## 4.4 Status tokens

Status tokens must be semantic and independent of domain enum names.

### Success

```text
color.status.success.foreground = #0F5D42
color.status.success.background = #E8F6F0
color.status.success.border     = #86CDB1
```

### Warning

```text
color.status.warning.foreground = #8A5200
color.status.warning.background = #FFF4E5
color.status.warning.border     = #E8B76A
```

### Danger

```text
color.status.danger.foreground = #8F1D27
color.status.danger.background = #FCEBED
color.status.danger.border     = #E8AAB1
```

### Info

```text
color.status.info.foreground = #1F4F86
color.status.info.background = #EAF2FB
color.status.info.border     = #9FC1E3
```

### Neutral

```text
color.status.neutral.foreground = #475467
color.status.neutral.background = #F2F4F7
color.status.neutral.border     = #D0D5DD
```

Status colors must always be accompanied by readable text and, where useful, icons or explicit labels.

---

## 4.5 Verified contrast baseline

The following working combinations have suitable contrast for normal text:

| Foreground | Background | Approx. contrast |
|---|---|---:|
| `#B4232E` | `#FFFFFF` | 6.52:1 |
| `#971B26` | `#FFFFFF` | 8.40:1 |
| `#172033` | `#FFFFFF` | 16.27:1 |
| `#667085` | `#FFFFFF` | 4.97:1 |
| `#0F5D42` | `#E8F6F0` | 7.08:1 |
| `#8A5200` | `#FFF4E5` | 5.88:1 |
| `#8F1D27` | `#FCEBED` | 7.69:1 |
| `#1F4F86` | `#EAF2FB` | 7.38:1 |
| `#475467` | `#F2F4F7` | 6.98:1 |

These nine pairs are individually verified. They do not make other combinations of the same tokens accessible:
§4.6 lists the combinations the system supports. Ratios in this document are computed from the hex values with the
WCAG 2.x relative-luminance formula and shown to two decimals; a ratio below its threshold is never rounded up to pass.
The thresholds are 4.5:1 for normal text and 3:1 for large text and for the visual cues that identify a control or its
state.

Every new color pairing introduced later must be checked independently and added to §4.6 before it is used.

---

## 4.6 Supported pairings and state recipes

Tokens are not freely combinable. A foreground, border or focus colour is supported only on the surfaces listed here;
a combination that is not listed is not supported. `✗` is below the threshold for the use named, and `thin` passes by
less than 0.25 and is supported only where the rule below says so.

### Text on surfaces

| Foreground | `surface.default` `#FFFFFF` | `surface.page` `#F7F8FA` | `surface.subtle` `#F2F4F7` | `surface.selected` `#FCEBED` | `surface.inverse` `#172033` |
|---|---:|---:|---:|---:|---:|
| `text.primary` `#172033` | 16.27 | 15.31 | 14.76 | 14.13 | ✗ 1.00 |
| `text.secondary` `#475467` | 7.69 | 7.23 | 6.98 | 6.68 | ✗ 2.12 |
| `text.muted` `#667085` | 4.97 | 4.68 thin | 4.51 thin | ✗ 4.32 | ✗ 3.27 |
| `text.link` `#971B26` | 8.40 | 7.90 | 7.62 | 7.30 | ✗ 1.94 |
| `text.linkHover` `#7D1720` | 10.42 | 9.81 | 9.46 | 9.05 | ✗ 1.56 |
| `text.inverse` `#FFFFFF` | ✗ 1.00 | ✗ 1.06 | ✗ 1.10 | ✗ 1.15 | 16.27 |

- `text.muted` is for supporting copy on `surface.default` and `surface.page`. On `surface.subtle` it passes by 0.01, so
  do not use it there; on `surface.selected` it fails (4.32), so use `text.secondary` or `text.primary`.
- `text.inverse` is for `surface.inverse` and for filled action colours, nowhere else.
- `text.disabled` (`#98A2B3`) is 2.58:1 on white. WCAG exempts inactive controls from contrast, so it is allowed only on
  a control that is really disabled (native `disabled`), and what it shows must be available elsewhere. A disabled
  state is never conveyed by this colour alone.
- Links are underlined in running text. `text.link` against `text.primary` is only 1.94:1, so colour does not
  identify a link.

### Control boundary

A text field is identified by its boundary, so the boundary must reach 3:1 against the surface the control sits on
(WCAG 1.4.11).

| Border | `surface.default` | `surface.page` | `surface.subtle` | `surface.selected` |
|---|---:|---:|---:|---:|
| `border.control` `#7C879B` | 3.62 | 3.41 | 3.29 | 3.15 thin |
| `border.strong` `#667085` | 4.97 | 4.68 | 4.51 | 4.32 |
| `border.default` `#D0D5DD` | ✗ 1.47 | ✗ 1.39 | ✗ 1.34 | ✗ 1.28 |
| `border.subtle` `#DDE1E7` | ✗ 1.31 | ✗ 1.24 | ✗ 1.19 | ✗ 1.14 |

- `border.control` is supported on all four light surfaces. The Product Owner darkened it from `#8A94A6` (3.06 on white,
  below 3:1 on every other surface) to `#7C879B` on 6 October 2026, so one token is the boundary of an input wherever it
  sits. On `surface.selected` it passes by 0.15, the thinnest margin: prefer `border.strong` there. `border.strong` stays
  the boundary where more emphasis is wanted, and `gray.500` is no longer used for a control boundary.
- `border.default` and `border.subtle` are structural and decorative. They are never the only boundary of an input.
  A button is identified by its label, so `border.default` on a Secondary button is allowed.

### Focus

| | `surface.default` | `surface.page` | `surface.subtle` | `surface.selected` | `surface.inverse` |
|---|---:|---:|---:|---:|---:|
| `focus.ring` `#2563A6` | 6.15 | 5.79 | 5.58 | 5.34 | ✗ 2.64 |
| `focus.ringInverse` `#FFFFFF` (proposed) | ✗ 1.00 | ✗ 1.06 | ✗ 1.10 | ✗ 1.15 | 16.27 |

- **Default recipe**, on every light surface: a 2px `focus.ring` outside a 2px band of `focus.offset` (white), so the
  indicator is also separated from a filled control such as Primary (white against `#B4232E` is 6.52:1).
- **Inverse recipe**, on `surface.inverse`: a 2px `focus.ringInverse` outside a 2px band of `focus.offsetInverse`
  (`#172033`). A blue ring on Ink is only 2.64:1, so the default recipe is not used there. Both inverse tokens are
  proposed here and become active with the rest of this document.
- Draw the indicator with `outline` so that forced-colors mode keeps it (it drops `box-shadow`). Do not clip it with
  `overflow: hidden`, and do not let a sticky region hide the focused control entirely (§14).

### Selected, inverse and status

- `surface.selected` supports `text.primary`, `text.secondary`, `text.link` and `status.danger.foreground` (7.69). A
  selected row is marked by more than its tint: a leading `color.action.primary` bar (5.67 against the tint, which
  exceeds the 3:1 a graphical cue needs) and the semantic state (`aria-current` or `aria-selected`).
- **Ink shell (the authenticated Ops shell only, §13.1).** Item text is `text.inverse` (16.27) or `gray.300` `#D0D5DD`
  (11.03). The active indicator cannot be `crimson.600`: `#B4232E` on Ink is 2.49:1, below 3:1. Use `crimson.300`
  `#EDA3AC` (8.08) or `crimson.500` `#C93D4A` (3.29); the active item is also marked by `aria-current` and a
  weight or text change, never by the colour alone. An inverse link is `text.inverse`, underlined (16.27), and its hover
  uses `crimson.200` `#F7CDD2` (11.32). These inverse choices are proposed.
- **The side menu on Ink (25 October 2026; the Product Owner's reference screenshot).** The menu is a vertical list, so the
  current item is a **filled item** and not a bar: `color.action.primary` with `color.action.primaryText` (6.52), written in
  weight 700 with `aria-current`, so the state is carried by the white text on the fill, the weight and the attribute, and the
  fill supports them (its edge against Ink is 2.49, below 3:1, which is why it is never the only cue). Idle items are
  `shell.text.muted` `gray.300` (11.03 on Ink); hovered, `shell.text` on `shell.surface.hover` `gray.900` `#1F2937`
  (14.68); pressed, on `shell.surface.pressed` `gray.800` (10.46); secondary text (the application's name, the account's
  hub) is `shell.text.subtle` `gray.400` (6.32 on Ink, 5.70 on hover); dividers are `shell.border` `gray.800`. Focus is the
  inverse recipe and holds 3:1 on each of those fills. These are aliases of the palette: no new colour is introduced, and
  every pairing is in `scripts/design-tokens.test.ts`.
- Status text pairs (foreground on its own soft background, on white, on page): success 7.08, 7.88, 7.42; warning 5.88,
  6.39, 6.01; danger 7.69, 8.85, 8.33; info 7.38, 8.33, 7.84; neutral 6.98, 7.69, 7.23. The base hues are not text
  colours: warning `#B76E00` is 4.00:1 against white and white on it is 4.00:1. Status borders are 1.3–1.9:1
  decoration; the text and the icon carry the meaning.

### State recipes for the initial components

Tokens only (written without the `color.` prefix of §4.3); the ratio is the text against its fill.

| Component, state | Fill | Text | Boundary and notes |
|---|---|---|---|
| Primary: default, hover, pressed | `action.primary`, `primaryHover`, `primaryPressed` | `action.primaryText` (6.52, 8.40, 10.42) | focus: default recipe |
| Primary: disabled | `action.disabled` | `text.disabled` (exempt, 2.18) | native `disabled`; loading keeps the label and the colours |
| Secondary: default, hover, pressed | `surface.default`, `surface.subtle`, `#EAECF0` | `action.secondaryText` (16.27, 14.76, 13.75) | `border.default` (decorative) |
| Tertiary: default, hover, pressed | none, `surface.subtle`, `#EAECF0` | `text.link`, `text.linkHover`, `text.linkHover` (8.40 on white, 9.46 and 8.81 on the hover and pressed fills) | no border |
| Danger (outline; approved 24 October 2026) | `surface.default`, `status.danger.background`, `#EAECF0` | `status.danger.foreground` (8.85, 7.69, 7.48) | wording names the consequence; never a filled button, because a fill of `#8F1D27` would be almost the same colour as Primary hover `#971B26` |
| Link: default, hover | none | `text.link`, `text.linkHover` | underlined in running text; no separate visited colour until a screen needs one |
| Input: default, hover | `surface.default` | `text.primary`; placeholder `text.muted` (4.97) | `border.control` (`border.strong` on `surface.selected`); hover `border.strong` |
| Input: invalid | `surface.default` | `text.primary`; message `status.danger.foreground` (8.85) | 2px `status.danger.foreground` border and an icon and the message and `aria-invalid`; never the red border alone |
| Input: read-only | `surface.subtle` | `text.primary` (14.76) | `border.strong` (4.51); value stays selectable; not styled as disabled |
| Input: disabled | `surface.disabled` | `text.disabled` (exempt) | `border.disabled`; native `disabled` |
| Alert, all five variants | `status.<variant>.background` | `status.<variant>.foreground` | `status.<variant>.border`, an icon and the text; an action link uses the foreground, underlined |

**Acceptance.** Examples on white, page, subtle, selected and inverse surfaces with the whole focus geometry visible
(a screenshot is part of the evidence). A test reads the token source and asserts that every pairing listed in this
section meets its threshold, so a later token change cannot silently break one. A failing ratio is never rounded up.

---

## 5. Typography

## 5.1 Typeface

The product UI typeface is **Inter**, approved by the Product Owner on 6 October 2026 and self-hosted by the Ops Portal.

The stack below shows while a font file loads and for any character Inter does not cover:

```text
Inter,
ui-sans-serif,
system-ui,
-apple-system,
BlinkMacSystemFont,
"Segoe UI",
sans-serif
```

How it is shipped (`apps/ops-web`; held by `test/fonts.test.ts`, `test/build.test.ts` and the browser tests):

- the files are committed under `src/assets/fonts/`, never hot-linked from a CDN. `fonts.json` there records the version,
  where the files came from and the SHA-256 of each file, and the SIL Open Font License 1.1 text ships with the build at
  `/licenses/Inter-OFL.txt`;
- Inter is a variable font. The Latin and Latin Extended subsets are shipped, one file each, and the browser fetches a
  subset only when the page holds a character of its `unicode-range`. They are declared for weights 400 to 600, the range
  of the type scale (§5.2). Other scripts use the stack above until a requirement names them;
- the files are never inlined into the stylesheet, because the Content-Security-Policy allows fonts from the app's own
  origin only (`font-src 'self'`) and refuses a `data:` address;
- `font-display: swap` keeps text readable over the stack while a file loads;
- the browser tests show that the page loads Inter under that policy and requests only its own files.

---

## 5.2 Typography tokens

| Token | Size | Line height | Weight | Use |
|---|---:|---:|---:|---|
| `text.display.sm` | 32px | 40px | 600 | exceptional top-level display |
| `text.heading.xl` | 28px | 36px | 600 | page title |
| `text.heading.lg` | 24px | 32px | 600 | major section |
| `text.heading.md` | 20px | 28px | 600 | section |
| `text.heading.sm` | 18px | 26px | 600 | card/panel heading |
| `text.body.lg` | 16px | 24px | 400 | emphasized body copy |
| `text.body.md` | 14px | 22px | 400 | default product body |
| `text.body.sm` | 13px | 20px | 400 | dense operational body |
| `text.label.md` | 14px | 20px | 500 | form label |
| `text.label.sm` | 12px | 18px | 500 | meta label |
| `text.caption` | 12px | 18px | 400 | secondary metadata |

### Rules

- Avoid font sizes below 12px for normal product information.
- Use semibold rather than bold for most hierarchy.
- Do not use uppercase for long labels.
- Uppercase may be used sparingly for compact metadata where readability remains high.
- Operational numbers may use tabular numerals where available.

---

## 6. Spacing

Melarc uses a 4px base spacing rhythm.

| Token | Value |
|---|---:|
| `space.0` | `0` |
| `space.1` | `4px` |
| `space.2` | `8px` |
| `space.3` | `12px` |
| `space.4` | `16px` |
| `space.5` | `20px` |
| `space.6` | `24px` |
| `space.8` | `32px` |
| `space.10` | `40px` |
| `space.12` | `48px` |
| `space.16` | `64px` |
| `space.20` | `80px` |

Do not introduce arbitrary one-off spacing values without a demonstrated layout need.

---

## 7. Radius

Use modest radii.

| Token | Value | Use |
|---|---:|---|
| `radius.none` | `0` | strict structural edges |
| `radius.sm` | `4px` | compact controls |
| `radius.md` | `6px` | default inputs/buttons |
| `radius.lg` | `8px` | cards/panels/dialog surfaces |
| `radius.xl` | `12px` | rare larger surfaces |
| `radius.full` | `9999px` | avatars/status dots/pills only where appropriate |

Avoid applying `radius.full` to ordinary controls merely for decoration.

---

## 8. Elevation

Prefer borders and surface contrast before shadows.

| Token | Definition | Use |
|---|---|---|
| `shadow.none` | none | normal flat structure |
| `shadow.sm` | `0 1px 2px rgb(16 24 40 / 0.06)` | subtle raised control/card |
| `shadow.md` | `0 4px 12px rgb(16 24 40 / 0.10)` | popover/dropdown |
| `shadow.lg` | `0 12px 28px rgb(16 24 40 / 0.14)` | modal/dialog |

Avoid deeper decorative shadows.

---

## 9. Motion

Motion should explain state change rather than decorate.

### Working durations

| Token | Value |
|---|---:|
| `motion.fast` | `120ms` |
| `motion.normal` | `180ms` |
| `motion.slow` | `240ms` |

### Rules

Use motion for:

- hover/focus state;
- menu/popover appearance;
- inline disclosure;
- loading transitions where useful.

Avoid:

- large page fly-ins;
- bouncing;
- decorative continuous animation;
- motion required to understand content.

Respect reduced-motion preferences.

---

## 10. Density system

Melarc uses three task-oriented density contexts.

### 10.1 Spacious

Use for:

- shell;
- page headers;
- onboarding;
- empty states;
- high-level dashboard sections.

Typical spacing:

```text
section gap: 32–48px
card padding: 24px
page horizontal padding: 24–32px desktop
```

### 10.2 Standard

Use for:

- normal forms;
- cards;
- detail panels;
- most interaction surfaces.

Typical spacing:

```text
control vertical rhythm: 16–20px
panel padding: 20–24px
field gap: 16px
```

### 10.3 Compact

Use for:

- operational tables;
- task queues;
- dense filters;
- repeated metadata.

Typical spacing:

```text
row height: approximately 40–44px where interaction allows
cell vertical padding: 8–10px
dense body text: 13–14px
```

Compact does not mean inaccessible.

Interactive targets that require pointer/touch use must remain appropriately usable.

---

## 11. Control sizing

### Web control heights

| Size | Height | Typical use |
|---|---:|---|
| `sm` | `32px` | dense desktop-only control |
| `md` | `40px` | default web control |
| `lg` | `48px` | prominent/touch-friendly action |

Default:

```text
button = md
input  = md
select = md
```

Do not use 32px controls on touch-dominant screens.

These heights are minimums. A control sets `min-height` in `rem`, so that enlarged text grows it, and its label wraps
instead of being clipped. Check controls with text enlarged to 200% and at 320 CSS pixels wide (§14).

---

## 12. Responsive model

The responsive system must adapt **layout**, not merely shrink it.

### Working breakpoints

| Token | Minimum width |
|---|---:|
| `breakpoint.sm` | `480px` |
| `breakpoint.md` | `768px` |
| `breakpoint.lg` | `1024px` |
| `breakpoint.xl` | `1280px` |
| `breakpoint.2xl` | `1536px` |

These are implementation baseline values and may be refined only with evidence from real layouts.

### Principles

- mobile-first CSS where practical;
- do not hide required actions just because width decreases;
- tables may reflow, scroll, or switch presentation depending on content;
- forms should collapse cleanly to one column;
- navigation patterns may change by viewport;
- do not assume desktop because the Ops Portal is operations-focused.

---

## 13. Layout rules

### 13.1 Layout families

The Ops Portal has three layouts, and the route tree chooses between them. They are not one component with optional
parts, because a pre-authentication page must never be able to show a signed-in affordance
([surfaces/ops-portal.md](../surfaces/ops-portal.md) §7).

| Layout | Route family | Contains | Never contains | In code |
|---|---|---|---|---|
| **Neutral frame** | any address that matches no route, and the development showcase | a skip link, a banner that names the product, the main landmark, the move of focus to the new page's heading after a navigation | navigation, a user menu, sign-out, session data, anything loaded for a signed-in user | `apps/ops-web/src/app/AppFrame.tsx` |
| **Authenticated Ops shell** | the signed-in routes (§7 of the Ops spec), and only those | the skip link and the landmarks, an **Ink side menu** docked at the left (the primary navigation, and an account card with the sign-out control), collapsible to a rail of icons and sliding in over the page on a narrow screen; **no banner**, because the menu carries the product's name | content for a caller who has no session | the frame in its sidebar layout, the menu drawn into the place beside the main content (`apps/ops-web/src/app/AuthenticatedOpsShell.tsx`, `components/side-menu/`; [COMPONENT_PATTERNS.md](COMPONENT_PATTERNS.md) §12.6). It was a band across the top until 25 October 2026, when the Product Owner decided that the Ops Portal is an application and not a website |
| **Split-screen layout** | the five pre-sign-in routes (`/sign-in`, `/sign-in/mfa`, `/setup/credential`, `/setup/mfa`, `/setup/mfa/complete`), and the two recovery routes when they are built; the setup routes are reached by a grant and carry no session | the skip link and the landmarks, the banner (the logo) above the main landmark that holds the form, and beside them a decorative panel of photography over a band of Ink with the mark and the name (§13.1a); under 64rem the panel is not drawn and the form is alone | the authenticated shell, navigation, anything loaded for a signed-in user | the frame in its split layout (`AuthSplitLayout`), its banner and main landmark unchanged; the five pre-sign-in screens (the sign-in pair and the three setup pages) are in `apps/ops-web/src/app/pages/pre-sign-in/` (S0.43; [COMPONENT_PATTERNS.md](COMPONENT_PATTERNS.md) §12.7) |

- The route tree chooses the layout; a page never decides which frame it sits in.
- Every layout keeps the skip link, the landmarks and the focus move after a navigation.
- A pre-authentication page shows no authenticated affordance in any state: loading, challenge, error or success. A
  `202` MFA challenge is not a session, so it renders in the neutral frame and shows no signed-in UI.
- An error or not-found page renders inside the layout of its route family. An address that matches no route belongs
  to none, and uses the neutral frame, because that page cannot know whether a session exists.
- A generic restyle does not wrap every route in the Ink shell.
- The authenticated shell should feel spacious and stable; the neutral frame is quiet, with no Ink navigation.

**Decided (Product Owner, 6 October 2026): the setup layout is the neutral frame.** The Ops spec says the setup routes
render "no application shell" and must not render "the authenticated shell". The neutral frame is not the authenticated
shell: it has a banner with the product name and no navigation. The product name (and the logo once an approved asset
exists, §26) is identification only and never navigation. Build nothing that makes the setup routes differ from the
neutral frame; if "no application shell" is later read as forbidding even that banner, the route tree changes, not the
components.

**Changed (Product Owner, 25 October 2026): the pre-sign-in screens, the setup pages included, are drawn in a split-screen
layout** (§13.1a). It is still the frame: the same skip link, landmarks, banner and move of focus, and still no navigation,
user menu or signed-in affordance in any state; what changes is that a decorative panel of photography stands beside the form
on a wide screen. The neutral frame stays for an address that matches no route.

### 13.1a The split screen

- Two halves from 64rem: the **photography** on the left (full height, sticky while the form scrolls), and the form on the
  right: the banner with the logo, and the main landmark holding the page's heading and form, centred in its half (a column of
  at most 30rem, about 430 px of form once the padding is taken). Below 64rem the photograph is not drawn and the form is alone,
  in the same column, centred; the photograph is not downloaded either (it loads lazily, and a panel that is not laid out is not
  loaded).
- The photograph fills what a solid band of Ink leaves, cropped to it and never stretched, and is **decorative**: empty alternative
  text, hidden as a whole from assistive technology, never the only carrier of meaning. The band carries the symbol on a white
  tile and the product's name as plain text (§25), in `text.inverse` on Ink (16.27), whatever the photograph is.
- The photographs are the Product Owner's (`design/images`), served as web-sized copies with no metadata
  (`apps/ops-web/src/assets/auth/README.md`). Which photograph goes with which screen is one table
  (`apps/ops-web/src/app/pages/pre-sign-in/auth-art.ts`); a screen with none shows the band of Ink alone, never a stand-in.
  Their licence and attribution are the Product Owner's to confirm.

### 13.2 Content width

Different content requires different width strategies.

- **Operational data/tables:** fluid width.
- **Forms:** constrained where very wide lines reduce usability.
- **Reading/explanatory content:** narrower measure.
- **Dashboard composition:** responsive grid.

Do not force every page into one fixed maximum width.

### 13.3 Form measure

Normal single-column forms should generally remain within approximately:

```text
560–720px
```

unless workflow requirements justify wider composition. Built as `FormPage` (`apps/ops-web/src/components/FormPage.tsx`): 40rem, which is
640 px at the default size and grows with enlarged text; the form of a signed-in screen uses it. The five pre-sign-in screens use it too,
but inside the column of the split screen, which is at most 30rem (§13.1a): a narrower measure than this one, because the form has the
half of a window and not a page (Product Owner, 25 October 2026).

---

## 14. Accessibility baseline

Melarc web interfaces target **WCAG 2.2 level AA** as a design baseline. It is a target, not a conformance claim.

**Relationship to the surface documents.** [surfaces/ops-portal.md](../surfaces/ops-portal.md) §11 and
[vendor-pwa.md](../surfaces/vendor-pwa.md) §9 state the same working target, WCAG 2.2 level AA (aligned by the Product
Owner on 6 October 2026), and leave the formal conformance level to a later Product Owner decision (master specification
§40.6). An implementation applies this section and never a weaker reading.

### Required defaults

- visible keyboard focus;
- semantic HTML before custom ARIA;
- associated input labels;
- accessible descriptions/errors;
- no color-only meaning;
- predictable keyboard sequence;
- sufficient contrast;
- meaningful button/link names;
- usable zoom/reflow;
- reduced-motion respect;
- appropriate live-region treatment for important asynchronous feedback.

### Measurable checks

The standard is referenced, not copied. Each row says what is checked and where the evidence comes from.

| Area | Check | Evidence |
|---|---|---|
| Contrast | Text 4.5:1 (3:1 for large text); control boundaries, state cues and focus 3:1 against the adjacent colour; only the pairings in §4.6 | the token pairing test (§4.6); axe `color-contrast` in the browser |
| Target size | WCAG 2.2 SC 2.5.8: a pointer target is at least 24×24 CSS pixels, or has enough space around it, or meets a listed exception. The project prefers about 44px or more wherever touch is expected (`lg`, 48px, §11); 24px is the minimum, not the aim | axe `target-size` enabled in the browser test; a manual pass on a touch device |
| Keyboard | Every function works by keyboard in a logical order; focus is always visible (2.4.7) | Vitest keyboard tests; the browser test |
| Focus not obscured | A focused control is never entirely hidden by a sticky header, footer or overlay (2.4.11); sticky regions set scroll padding | a manual keyboard pass in the real layout; a browser test as soon as a sticky region exists |
| Zoom and reflow | Content reflows at 320 CSS pixels without two-dimensional scrolling, and text enlarges to 200% without loss (1.4.10, 1.4.4); a data table may scroll in both directions on purpose | a browser test at 320 px; a manual 200% pass |
| Forced colours, motion | Under `forced-colors: active` the focus indicator and control boundaries remain; `prefers-reduced-motion` is honoured; no native focus style is removed without a tested replacement | a manual pass in Windows high contrast; a browser test with the media features emulated |
| Forms | A label for every control, with a stable id; help and error linked with `aria-describedby`; `aria-invalid` on an invalid field; after a failed submit focus goes to the first error or to an error summary; each error is announced once, not by a live region on top of `role="alert"` | Vitest tests of each field and form; a manual screen-reader pass |
| Accessible authentication | Password managers and paste are allowed; fields carry the right `autocomplete` (`username`, `current-password`, `new-password`, `one-time-code`); entering a one-time code is not a transcription puzzle (3.3.8) | Vitest on the attributes; a manual pass with a password manager |

Where a feature has the interaction, also apply 2.5.7 Dragging Movements (a single-pointer alternative), 3.3.7 Redundant
Entry and 3.2.6 Consistent Help.

### What the automated checks cover today

- Vitest (jsdom), `apps/ops-web/src/test-support/wcag.ts`: axe with the `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`
  tags, and keyboard, label, description and state tests of each component. Colour contrast is off there, because jsdom
  has no layout.
- The token test, `scripts/design-tokens.test.ts`: the token file equals this document, every pairing the components
  use meets its threshold from the file's own values, no colour is written outside the file, and every focus rule draws
  an outline.
- The browser tests, `apps/ops-web/test/browser/`: `shell.spec.ts` against the production build and `components.spec.ts`
  against the development-only showcase. They run axe with the WCAG 2.2 tags, so contrast and `target-size` are checked
  with layout, at 1280, 768 and 320 px; no sideways scrolling at those widths; keyboard order, Enter and Space, and the
  focus ring on every stop; text enlarged to 200%; forced colours (not WebKit, which Playwright cannot emulate) and
  reduced motion; and a failed submit that moves focus to the first invalid field.
- axe-core 4.13.0 has one WCAG 2.2 AA rule, `target-size`, which the browser tests enable. The other new 2.2 criteria
  (focus not obscured, accessible authentication, redundant entry, dragging, consistent help) have no automated rule and
  rest on the manual checks above.
- An automated scan does not prove these behaviours. Before the first identity flow is accepted, record one
  keyboard-only pass and one screen-reader pass (a desktop screen reader with its usual browser, for example NVDA with
  Firefox or Chrome), with the versions used and what was done.

### Supported browsers

The promise stays: the current and previous major release of Chrome, Edge, Firefox and Safari on desktop
([surfaces/ops-portal.md](../surfaces/ops-portal.md) §11). The Playwright browser tests run Chromium, Firefox and WebKit
in CI (`MELARC_BROWSERS`; Chromium alone runs locally unless more are installed). Edge is Chromium and WebKit is
Safari's engine, not Safari itself, and only the engines' current releases are tested: Safari as a product and the
previous major releases remain a manual check.

---

## 15. Form design

Every field may consist of:

```text
Label
Control
Optional help text
Validation/error text
```

### Rules

- placeholder text never replaces a label;
- required fields must be programmatically identifiable;
- error text should explain correction;
- server errors remain authoritative;
- disabled and read-only are visually distinct;
- destructive or irreversible settings should not be hidden among ordinary fields.

### Field states

Minimum states:

- default;
- hover where applicable;
- focus;
- filled;
- invalid;
- disabled;
- read-only.

---

## 16. Buttons and actions

### 16.1 Hierarchy

The permitted vocabulary (the first implementation builds only the variants a current screen uses, `COMPONENT_PATTERNS.md`
§42):

1. **Primary** — main page/action intent.
2. **Secondary** — normal alternate action.
3. **Tertiary/text** — lower emphasis.
4. **Danger** — destructive action.

A screen should rarely contain several equally prominent primary actions.

### 16.2 Primary action

Working style:

```text
background: color.action.primary
text: color.action.primaryText
hover: color.action.primaryHover
pressed: color.action.primaryPressed
focus: focus.ring
radius: radius.md
```

### 16.3 Danger action

Danger must be a separate semantic variant.

Do not reuse the primary button token merely because both may initially use similar reds.

Danger actions require explicit destructive wording.

---

## 17. Links

Links should:

- remain visually distinguishable from body text;
- have hover/focus treatment;
- not rely solely on color where ambiguity exists;
- use normal link semantics for navigation rather than button semantics.

Do not style every navigation action as a button.

---

## 18. Loading states

Choose loading treatment according to duration and layout stability.

### Spinner

Use for:

- compact local action;
- indeterminate process;
- button submission.

### Skeleton

Use when:

- layout is known;
- replacing content would otherwise create large layout shift;
- wait duration justifies it.

### Rules

- never show a fake success while work is pending;
- prevent duplicate submission where required;
- keep cancellation/retry behavior aligned with the underlying operation;
- preserve authoritative server state.

---

## 19. Empty states

Empty states should explain:

1. what is empty;
2. whether this is expected;
3. the next useful action, if one exists.

Avoid decorative empty states that hide operational meaning.

Never fabricate example records that look like production data.

---

## 20. Error states

Error presentation must distinguish:

- validation error;
- permission/forbidden state;
- not found;
- conflict/stale state;
- temporary service failure;
- session expiry;
- irreversible failure where applicable.

Do not collapse every error into "Something went wrong."

Server-provided error semantics remain authoritative.

---

## 21. Status presentation

Domain states map to semantic presentation.

Do not map raw enum strings directly to raw colors.

Recommended pattern:

```text
domain state
    ↓
presentation mapping
    ↓
semantic status token
```

Example conceptually:

```text
completed-like → success
attention-like → warning
failed-like    → danger
pending-like   → neutral/info
```

Exact mappings belong with implemented domain patterns.

---

## 22. Navigation

Navigation belongs to the authenticated Ops shell (§13.1). The neutral frame and the split screen carry none.

**It is a side menu, not a band across the top** (Product Owner, 25 October 2026: the Ops Portal is an application and not a
website). Docked at the left on a wide screen, full height, on Ink; a button at its head collapses it to a rail of icons and
expands it again, and every entry keeps its name when collapsed (visually hidden, with the name as a tooltip). On a narrow screen
(under 48rem) it is hidden, a slim bar with a menu button stands in its place, and the menu slides in over the page: the page
behind it is inert, Escape, the scrim, the close button and following a link close it, and focus goes in on opening and back on
closing. Its foot is the account card: the person's initials, name and where they act, and an icon button that signs out. The
choice of collapsed or expanded is kept while the page lives and not longer (nothing is written to web storage).

Navigation should communicate:

- current location;
- hierarchy;
- available modules;
- permission-aware visibility;
- application context.

Permission-aware navigation is usability only.

Backend authorization remains authoritative.

Which entries a session may use comes from the `permissions` list of the `Session` resource: the permission keys the
session holds, from the snapshot taken when it was created (decided 6 October 2026; [contracts/openapi.yaml](../contracts/openapi.yaml)).
An entry is shown when the session holds the key its screen needs. Never infer entries from a role name, and never fill
the menu with placeholders. The navigation component takes a plain list; the authenticated Ops shell (S0.42) gives it the entries of
the route registry whose key the session holds, and an entry exists only for a route that is built. The server stays authoritative:
a hidden entry is a convenience, and a shown one is not a grant.

### Active navigation

Recommended treatment:

- Ink shell;
- selected item gains clear contrast;
- Crimson is used as controlled accent rather than filling the whole shell.

As built: the current entry is a filled item (§4.6) with an icon and its name; the icon is the one the landing gives the same
place, so one meaning has one picture.

---

## 23. Tables and dense operational data

Tables are central to Ops workflows but should not be prematurely generalized into a complex data-grid framework.

Initial rules:

- clear column alignment;
- persistent headers where useful;
- readable row height;
- explicit sort/filter states;
- numbers aligned consistently;
- actions discoverable without overwhelming each row;
- empty/loading/error states defined;
- horizontal overflow handled intentionally;
- keyboard support appropriate to interaction complexity.

The first design-system gate does **not** require a complete generic data-grid abstraction.

**Advanced grid behavior is weighed against a screen before it is built by hand.** Selection, resizing, column pinning, virtualization
and in-place editing are not built on speculation. When a concrete screen's requirements exceed this table, a specialist grid is
evaluated against those requirements first, on the terms of §24a: one door behind a Melarc component, appearance from the portal's
tokens alone, no inline style under the content-security policy, the accessibility baseline (§14) met, a licence that ships with the build. Only if no grid serves
the screen is the behavior built here. Either way it is a new pattern (COMPONENT_PATTERNS §37) and a change of technical foundation,
surfaced before it is built ([PRODUCT_DESIGN_DIRECTION §7](PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision)).

---

## 24. Icons

Use one coherent icon family per application.

Rules:

- labels remain primary for critical actions;
- icon-only controls require accessible names;
- use familiar symbols where possible;
- avoid mixing stroke weights/styles;
- status icons supplement, not replace, state text.

**Decided (Product Owner, 25 October 2026): the family is Lucide** ([github.com/lucide-icons/lucide](https://github.com/lucide-icons/lucide),
ISC licence, the `lucide-react` package, bundled with the application and never loaded from a CDN; its licence text ships in
`licenses/Lucide-ISC.txt`). It was chosen with the first screens that needed icons: the side menu, the show-password control and
the status pictures.

- **One door.** `apps/ops-web/src/components/ui/icon/icons.ts` is the only file that imports the library (a test and a lint rule
  say so). It names every icon by its **meaning** (`warning`, `success`, `sign-out`, `show-password`), never by the library's
  name for the picture, so the application can change a picture or the family in one place. An icon is added when a screen needs
  it, with its meaning; there is no catalogue of icons nobody uses (a test fails on one).
- **One look.** `<Icon name="…" />` draws every icon with the same **2px stroke**, in the colour of the text around it
  (`currentColor`), at one of three sizes from tokens: `icon.size.sm` 1rem, `md` 1.25rem (the default), `lg` 1.5rem, in rem so
  that enlarged text enlarges them. The same meaning has the same picture everywhere: one `warning` for a thing that went wrong
  (alerts and field errors), one `success` for a thing that worked.
- **Words stay primary.** An icon that repeats adjacent text is decorative (`aria-hidden`, so nothing is read twice). A control
  that is only an icon is an **IconButton** (COMPONENT_PATTERNS §22): a native button whose accessible name is its required
  `label` (it names the act: "Show password", not "Eye"), at least 2rem square, with the label repeated as a `title` for a
  pointer user. An icon is never the only carrier of an important operational meaning (BRAND_FOUNDATION §9).
- **What has icons today:** the menu's entries and its controls, the account's sign-out, the status pictures of an alert, an
  empty state and a field's error, the sort arrows of a table, the pager's chevrons and the eye of a password field. The icons
  are the Product Owner's choice of family; the individual pictures are provisional like the rest of this document.

---

## 24a. Interaction primitives

Some behaviour has no native element that does it the same way in every browser: a calendar, a menu, a searchable list. For that, and
for nothing a native element can do, the portal uses **React Aria Components** (Adobe's `react-aria-components`, Apache-2.0, an exact
pin). It gives **behaviour** (keys, focus, names for assistive technology, positioning) and **no appearance**: the look is the portal's
alone.

**Decided (Product Owner, 28 October 2026).** It was chosen after the same screen was built with React Aria Components, Ant Design 6 and
Mantine 9 and run under the portal's content-security policy (no inline style). The other two bring a look and a token system of their own,
which BRAND_FOUNDATION §14 does not let a library impose; under that policy Ant Design drew nothing of its theme (it needs a nonce on every
response of a static front, and three violations remained even then) and Mantine lost the portal's colours. Material UI was considered and
not built. The two builds were scratch work and are not kept in the repository; [the plan's §7.50](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026) records what each did.

- **One door.** Only the components of `apps/ops-web/src/components/ui/` import the library, `react-aria`, `react-stately`, the
  `@react-aria`, `@react-stately` and `@react-types` packages and `@internationalized/*` (a test and a lint rule say so). A page uses a
  component of the portal, whose properties are the portal's own, and never a type, a date object or a styling hook of the library.
- **Native first.** A native element is used wherever it does the job (button, input, select, `<dialog>`, table). The library is for what
  none can do, and a component of it is built when a screen needs it (COMPONENT_PATTERNS §37), never as a catalogue.
- **One look.** A component draws itself from `tokens.css` alone, as every component does (the token guard applies to it), takes the global
  focus ring of `base.css` on every part that takes focus, keeps every part a pointer can press at least 24px (WCAG 2.2 target size; the
  date field's buttons are 2rem, its parts 1.875rem) and its sizes in rem, and has forced-colours and reduced-motion rules of its own. The library's states reach the stylesheet as `data-*` attributes; the component's own states are classes.
- **No inline style.** The first time a pressable thing mounts, the library inserts one `<style>` into the page, which a policy without
  inline styles refuses. It does not when an element with its id exists: `index.html` has one, and the same rule is in `base.css`. A test
  holds the rule to the installed library's, and a browser test serves a production build of the showcase under the strict policy and
  requires no violation.
- **Licences.** The licence of the library and of each package it brings that carries one ships with the build, byte for byte
  (`public/licenses/`, held by a build test), and a test holds the list of those packages to the lockfile. Two carry none and are named in
  the test: `client-only` (an empty module) and `tslib` (0BSD, which asks for no notice).
- **Dates.** A date crosses into and out of a component as the text `YYYY-MM-DD`, as the API carries a calendar date. It is entered and
  shown day, month, year, with the week from Monday and English month names, **fixed by the portal and not taken from the browser**
  (decided 28 October 2026), for the reason `formatInstant` takes no words from a locale: a screen must not change with the machine, and
  03/04 must never mean two different days. "Today" is the day in Accra, whatever the zone of the machine.
- **No framework migration.** React Aria Components is a source of behaviour behind the portal's components, not a step towards a component
  framework. The web applications are not migrated project-wide to Ant Design, MUI or another UI framework (decided 1 November 2026): each
  brings a look and a token system of its own, which BRAND_FOUNDATION §14 does not let a library impose. The semantic tokens control
  appearance. Proposing one is a foundation change (§34) and is surfaced first
  ([PRODUCT_DESIGN_DIRECTION §7](PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision)).
- **Web only.** This policy is for the web applications, the Ops Portal and, when it is built, the Vendor PWA. It does not prescribe
  Android implementation libraries: the Rider app maps the same semantic foundations to native Android (§30).

---

## 25. Logo inside product UI

The logo belongs primarily in:

- application identification;
- authentication/onboarding;
- navigation shell where appropriate;
- approved branded documents.

Avoid repeating the logo as decorative content.

Where the artwork lives, and the rules for using it, are in §26, which owns them.

---

## 26. Brand asset repository structure

This section owns the layout of the brand assets. `BRAND_FOUNDATION.md` §19 lists the assets that are missing and
links here for where they go.

Canonical structure:

```text
design/
├── BRAND_FOUNDATION.md
├── DESIGN_SYSTEM.md
├── COMPONENT_PATTERNS.md
└── assets/
    └── brand/
        ├── master/
        │   └── melarc-logo-primary.svg
        ├── exports/
        │   ├── melarc-logo-primary.png
        │   ├── melarc-logo-dark.svg
        │   └── melarc-symbol.svg
        └── README.md
```

Rules:

- `master/` contains authoritative editable/vector source.
- `exports/` contains approved derived assets.
- unavailable/unapproved variants should not be invented merely to fill the structure.
- application runtime locations are not the canonical source.
- do not duplicate edited logo versions across apps.

A shared runtime package such as `packages/brand-assets/` may be introduced later if multiple applications need the same approved exports.

### 26.1 Source, export and use

- `master/` holds the approved vector source and `exports/` the derived files the applications may use. A line in
  `design/assets/brand/README.md`, created with the first asset, records where each file came from and who approved it.
- Until the original artwork is supplied, the sampled PNG is a reference only (`BRAND_FOUNDATION.md` §4.3). It does not
  go in `exports/`, and temporary artwork is never called official.
- A runtime copy lives with the application that serves it and is copied from `exports/`; nobody edits it there.
  `packages/brand-assets/` is created when a second application needs the same files, not before.
- No placeholder, symbol-only or dark variant is made to fill the structure, and the foundation gate does not wait for
  one. Until the approved SVG exists, the neutral frame names the product in text.
- Alternative text: when the logo is the only thing that identifies the product, its alternative text is the product
  name ("Melarc Logistics"). When visible text beside it already says so, it is decorative (`alt=""`) so that it is not
  announced twice. When it is a link, the link's accessible name states where it goes.

---

## 27. Initial implementation scope

The first Melarc UI-foundation implementation should remain small, and each item below is built only as far as
`COMPONENT_PATTERNS.md` §42 says.

### Required initially

- token definitions;
- typography setup;
- page/surface foundation;
- focus treatment;
- Button;
- Link;
- basic Field/Input/Label/Help/Error treatment;
- Alert;
- basic loading indicator;
- PageHeader;
- neutral application frame;
- not-found/error presentation;
- development-only visual showcase.

### Explicitly deferred until demanded by real screens

- comprehensive data grid;
- dialog framework;
- drawer system;
- toast architecture;
- dropdown/menu system;
- tabs abstraction;
- command palette;
- charts;
- complex navigation variants;
- generic form engine.

Add these when real product requirements need them.

---

## 28. Component implementation rules

When a reusable component is introduced:

1. derive it from a real product need;
2. document its states;
3. use semantic tokens;
4. support required keyboard behavior;
5. expose accessible labeling;
6. define loading/disabled/error behavior where applicable;
7. test behavior rather than only snapshots;
8. add the implemented pattern to `COMPONENT_PATTERNS.md`.

Do not build speculative APIs for future components.

---

## 29. Web implementation mapping

The design system is technology-neutral.

If CSS custom properties are used, semantic tokens should map cleanly:

```css
:root {
  --color-surface-page: #f7f8fa;
  --color-surface-default: #ffffff;

  --color-text-primary: #172033;
  --color-text-secondary: #475467;

  --color-action-primary: #b4232e;
  --color-action-primary-hover: #971b26;

  --color-border-control: #7c879b;

  --focus-ring: #2563a6;
}
```

This example describes token intent, not a requirement to use plain CSS.

If Tailwind, CSS Modules, vanilla CSS, or another system is selected, it must consume the same semantic design model.

### 29.1 Token source, names and units

- **One executable source.** The tokens live in one file in the application that uses them (CSS custom properties under
  `apps/ops-web/src/styles/`), and components consume only that file. No second hand-maintained copy (JSON, TypeScript
  or Android resources) is kept beside it. When Vendor or Android needs the same tokens, the extraction decision is made
  then, either a shared package or a format-neutral source from which each platform's file is generated, and the
  generated files replace any hand copy.
- **Names.** A dotted token path becomes a custom property by replacing dots with hyphens and camelCase with
  kebab-case: `color.action.primaryHover` is `--color-action-primary-hover`.
- **Units.** Type and spacing are in `rem` (1rem is 16px, so 14px is `0.875rem`), which lets text enlargement scale them.
  Borders, outlines and focus widths are in `px`. A control height is a minimum, and a label wraps instead of clipping
  (§11).
- **Scope.** Application-local tokens and components first. A shared package is created when a second real consumer
  exists.
- **Checks.** The pairing test of §4.6 reads this file, so the contrast table cannot drift from the tokens.

---

## 30. Android mapping

Rider Android should map the same semantic concepts into native Android resources/theme values.

For example:

```text
color.action.primary
color.status.success.foreground
space.4
radius.md
```

may have Android-native representations.

Do not make Android depend on web CSS or DOM-oriented component packages.

Android touch target, navigation, back behavior, system bars, accessibility services, and interaction conventions remain native concerns.

---

## 31. Dark mode

Dark mode is **deferred**.

Do not create a second theme during initial bootstrap merely for completeness.

Token naming must nevertheless avoid assumptions that make future theming impossible.

For example prefer:

```text
color.surface.default
```

over:

```text
white
```

inside components.

---

## 32. Design-system quality checks

Before accepting a UI-foundation change, verify:

### Tokens
- [ ] no raw brand values scattered through feature components;
- [ ] semantic aliases used;
- [ ] brand and danger remain separate;
- [ ] control border remains perceivable;
- [ ] warning pairs are accessible.

### Typography
- [ ] hierarchy uses defined tokens;
- [ ] no arbitrary font sizes;
- [ ] dense data remains readable.

### Spacing
- [ ] values come from the spacing scale;
- [ ] density matches task context.

### Accessibility
- [ ] visible focus;
- [ ] labels connected;
- [ ] no color-only meaning;
- [ ] keyboard behavior correct where applicable;
- [ ] contrast verified.

### Responsiveness
- [ ] layout reflows intentionally;
- [ ] required actions remain available;
- [ ] dense data behavior is defined.

### Branding
- [ ] logo artwork is approved;
- [ ] no silent recoloring;
- [ ] crimson is restrained;
- [ ] interface still feels operational rather than promotional.

---

## 33. Technology decisions intentionally not made here

This document does **not** approve:

- Tailwind CSS;
- Radix UI;
- shadcn/ui;
- Material UI;
- Ant Design;
- Storybook;
- another component workshop;
- CSS Modules;
- CSS-in-JS;
- ~~a library for behaviour a native element lacks~~ (decided on 28 October 2026: React Aria Components, §24a; Ant Design and Mantine were
  built and run for it and Material UI was considered, and React Aria Components was chosen over them);
- ~~a specific icon library~~ (decided on 25 October 2026: Lucide, §24).

Those should be selected based on the actual web implementation and project constraints.

The selected technology must serve this design system, not redefine it.

Since 1 November 2026 a project-wide move to Ant Design, MUI or another UI framework is outside the approved direction, and a specialist grid
is weighed against a concrete screen before advanced grid behavior is built by hand (§24a, §23).

---

## 34. Design review expectations

Design-system changes should be reviewed at two levels.

### Foundation change

Examples:

- changing action crimson;
- changing typeface;
- changing spacing scale;
- changing status semantics.

These require deliberate review because they affect many screens.

### Component refinement

Examples:

- improving Button padding;
- changing Alert internal spacing;
- adding a missing Input state.

These may evolve with implementation if they remain consistent with foundation rules.

---

## 35. Relationship to component patterns

`design/COMPONENT_PATTERNS.md` must document only components or interaction patterns that:

- exist in code; or
- are immediately being implemented for an approved requirement.

It should not become a speculative design catalogue.

Each pattern should eventually document:

- purpose;
- variants;
- anatomy;
- states;
- accessibility behavior;
- density rules;
- responsive behavior;
- examples of correct/incorrect use.

---

## 36. Current design-system decision summary

| Item | Status |
|---|---|
| Crimson + Ink direction | **APPROVED** |
| Balanced density model | **APPROVED** |
| Semantic token architecture | **APPROVED** (Product Owner, 6 October 2026) |
| Primitive palette values | **APPROVED** (6 October 2026) |
| Interface crimson `#B4232E` | **APPROVED** as the active interface value (6 October 2026); the logo's own red stays a reference until the vector artwork is supplied (§4.1) |
| Interface ink `#172033` | **APPROVED** as the active interface value (6 October 2026) |
| Inter | **APPROVED** (6 October 2026), self-hosted as the variable Latin and Latin Extended files of §5.1 under the SIL Open Font License 1.1 |
| 4px spacing base | **APPROVED** (6 October 2026) |
| Responsive breakpoint set | **APPROVED** (6 October 2026) |
| Blue focus ring `#2563A6` | **APPROVED** (6 October 2026) |
| Dark mode | **DEFERRED** |
| Tailwind | **NOT DECIDED** |
| Radix | **NOT DECIDED** |
| Shared web component package | **NOT YET REQUIRED** |
| Shared brand asset package | **POSSIBLE LATER** |
| Supported pairings and state recipes (§4.6) | **APPROVED** (6 October 2026), including the danger outline recipe |
| Inverse focus, inverse link and Ink-shell indicator values (§4.6) | **APPROVED** as proposed (Product Owner, 6 October 2026); first used by the authenticated Ops shell |
| `border.control` | **DECIDED** 6 October 2026: darkened to `#7C879B` (`gray.550`), 3:1 on every light surface (§4.6); a provisional value like the rest |
| WCAG 2.2 AA design baseline (§14) | **DECIDED** 6 October 2026: components are tested to 2.2 AA, and `surfaces/ops-portal.md` §11 and `vendor-pwa.md` §9 now say 2.2 AA is the working target; the formal conformance level stays **OPEN** (master §40.6) |
| Setup routes: neutral frame or a bare layout (§13.1) | **DECIDED** 6 October 2026: the neutral frame |
| First implementation scope (COMPONENT_PATTERNS §42.2) | **CONFIRMED** 6 October 2026, built in three increments |
| Browser coverage of the component acceptance (§14) | **DECIDED** 6 October 2026: Chromium, Firefox and WebKit in CI; Chromium locally unless the others are installed |
| Source of the signed-in navigation entries (§22) | **DECIDED** 6 October 2026: the `permissions` list of the `Session` resource |
| The authenticated shell's navigation: a top band or a side menu (§13.1, §22) | **DECIDED** 25 October 2026 (Product Owner, with a reference screenshot): a collapsible **side menu** on Ink with an account card; the Ops Portal is an application, not a website |
| Layout of the pre-sign-in screens (§13.1, §13.1a) | **DECIDED** 25 October 2026 (Product Owner): a **split screen**, photography beside the form; the photographs are theirs (`design/images`), their licence is theirs to confirm |
| Icon family (§24) | **DECIDED** 25 October 2026 (Product Owner): **Lucide**, through one registry; IconButton is built |
| Interaction primitives (§24a) | **DECIDED** 28 October 2026 (Product Owner): **React Aria Components** for behaviour only, through the components of `components/ui`; the date field is its first component |
| Web library policy (§23, §24a) | **DECIDED** 1 November 2026 (Product Owner): native elements first; React Aria Components behind Melarc's components; the semantic tokens control appearance; **no project-wide migration** to Ant Design, MUI or another UI framework; a **specialist grid is weighed against a concrete screen's requirements** before advanced grid behavior is built by hand; a web policy that does not prescribe Android libraries |
| Date entry and display (§24a; COMPONENT_PATTERNS §22a) | **DECIDED** 28 October 2026 (Product Owner): day, month, year, week from Monday, English; fixed by the portal and not the browser's; "today" is Accra's |
| Brand asset layout (§26 owns it) | **DECIDED in this revision** (document structure; no brand approval implied) |
| Self-hosted typeface files | **NOT STARTED** until a typeface is accepted (§5.1) |

---

## 37. Next design artifact

The next design artifact is:

```text
design/COMPONENT_PATTERNS.md
```

It should begin small and document only the initial UI-foundation components:

- Button;
- Link;
- Field/Input/Label/Help/Error;
- Alert;
- loading indicator;
- PageHeader;
- application frame;
- error/not-found state.

Expand it only alongside implementation.

---

**End of Melarc Design System v1.1**
