# Melarc Design System

> **Status:** ACTIVE DESIGN BASELINE — grounded in the approved Melarc Brand Foundation; approved by the Product Owner on 6 October 2026  
> **Version:** 1.2  
> **Date:** 5 October 2026; revised 6 October 2026 to reconcile it with the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md) (§4.6, §11, §13.1, §14, §22, §24–§26, §29, §36), and again on 5 November 2026 for the Ops Portal redesign: its direction (§4.7, §5.1, §5.2, §7 to §12, §13.1, §16, §17, §22 to §24a, §27, §31, §33, §36) and, in redesign step R2, its values, which replaced the palette, radii, heights, shadow and motion of 6 October 2026 (§2.5, §3 to §5, §7 to §11, §14, §29, §31, §36)  
> **Repository path:** `design/DESIGN_SYSTEM.md`  
> **Depends on:** `design/BRAND_FOUNDATION.md`  
> **Owns:** semantic design tokens, accessibility rules, typography scale, spacing, radius, elevation, focus treatment, responsive behavior, density, UI state presentation, token naming, the web UI library policy (§23, §24a), and the initial UI-foundation implementation scope  
> **Does not own:** product workflows, business rules, API behavior, domain state semantics, logo source artwork, or speculative component APIs

---

**Approval (Product Owner, 6 October 2026).** This document is approved and its values are active. Where the text still says
"proposed" or "provisional" about a value (the inverse focus and link recipes, the interface crimson and ink, the palette,
the spacing, breakpoints and focus ring), that approval settles it. What stays open is only what §36 shows as OPEN, NOT
DECIDED, DEFERRED, NOT STARTED or NOT YET FINAL. A change to an approved value is a foundation change (§34) made here, in
the same commit as the token file. The values of 5 November 2026 (the palette of §4.3 and §4.4 for the light and the dark
theme, the type of §5.1, the radii, the one shadow, the motion and the heights of §7 to §11) have been the values in force
since redesign step R2, and replace those of 6 October 2026.

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
#BE1E2D
#0E1525
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
white
black
space.4
radius.md
shadow.floating
```

Colour has only two primitives, `white` and `black` (§4.2). Every other colour changes with the theme, so it is a semantic token with a light value and a dark value (§4.3), and no primitive stands behind it.

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

The application interface uses a Crimson + Ink palette.

**Decided (Product Owner, 5 November 2026; in force since step R2).** The interface crimson is the logo red itself, `#BE1E2D` (it replaced `#B4232E`, approved on 6 October 2026), and crimson has a smaller job than the primary action did (§4.7). The supplied vector master fills its red with `#be1e2d`, the value sampled from the PNG; it remains a logo reference value until the owner confirms the master ([the brand README](assets/brand/README.md)).

The logo must not be recolored merely to match interface tokens.

---

## 4.2 Primitive color palette

Two colors are the same in every theme, so they are primitives: they name a raw value that does not change.

| Token | Value | Usage |
|---|---:|---|
| `white` | `#FFFFFF` | The tile behind the symbol in the product lockup (the symbol is black and red, so the tile stays white in both themes), and the background of a QR code. |
| `black` | `#000000` | The modules of a QR code: a scanner reads dark on light in both themes. |

Every other color of the interface changes with the theme (§31), so it is a semantic token with a light value and a dark value (§4.3, §4.4) and no primitive stands behind it. The crimson, ink and gray scales of 6 October 2026 (`crimson.50` to `crimson.900`, `ink.950`, `gray.50` to `gray.900`, with `gray.550`) and the table of supporting hues were replaced by the palette of 5 November 2026 in redesign step R2.

---

## 4.3 Core semantic color tokens

Each token has a value for the light theme and a value for the dark theme ([§31](#31-dark-mode)), and a component consumes the token and never a value. The palette is the Product Owner's, given on 5 November 2026 and corrected for contrast the same day; the values it did not give were derived by step R2 and say so in the Role column, and the rule of each is at the end of this section.

### Surfaces

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `color.surface.page` | `#F3F4F7` | `#090D16` | Canvas, the ground of every page. |
| `color.surface.default` | `#FFFFFF` | `#10151F` | Surface: cards, forms, tables and panels. |
| `color.surface.raised` | `#F8F9FB` | `#141A26` | Raised surface: menus, popovers, the record panel and toasts. |
| `color.surface.subtle` | `#EEF0F4` | `#0C111A` | Sunken surface: recessed bands, read-only fields and hover fills. |
| `color.surface.inverse` | `#0E1525` | `#0C111A` | Ink: the sidebar and the band of the split screen, a dark ground in both themes. |
| `color.surface.selected` | `#E2E5EB` | `#16202F` | A selected row or day: an Ink tint, never crimson. Derived. |
| `color.surface.disabled` | `#EEF0F4` | `#0C111A` | A disabled field: the sunken surface. |

### Text

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `color.text.primary` | `#0E1525` | `#EDF0F6` | Primary text. |
| `color.text.secondary` | `#475066` | `#A9B2C3` | Secondary text. |
| `color.text.muted` | `#626B81` | `#8E98AC` | Tertiary text: supporting copy. |
| `color.text.disabled` | `#8A94A8` | `#667085` | Text on a disabled control; exempt from contrast. Derived. |
| `color.text.inverse` | `#FFFFFF` | `#FFFFFF` | Text on `surface.inverse`, the sidebar, in both themes. |
| `color.text.link` | `#0E1525` | `#EDF0F6` | Links are Ink, not crimson. |
| `color.text.linkHover` | `#BE1E2D` | `#F04B59` | A hovered link is the brand crimson. |

### Borders

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `color.border.subtle` | `#E2E5EB` | `#222A38` | Decorative separators only. |
| `color.border.default` | `#C9CED8` | `#333D4F` | Normal structural borders. |
| `color.border.control` | `#7C859A` | `#667085` | Control boundary where a border is visually required: at least 3:1 on the surfaces §4.6 lists. |
| `color.border.strong` | `#626B81` | `#8E98AC` | High-emphasis boundary: the value of `text.muted`. Derived. |
| `color.border.disabled` | `#E2E5EB` | `#222A38` | Disabled treatment: the subtle border. |

`color.border.subtle` must not be the sole required visual boundary of an input or interactive control.

### Brand

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `color.brand.default` | `#BE1E2D` | `#F04B59` | The brand crimson: the small square that marks the active hub and the current step. |

### Actions

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `color.action.primary` | `#0E1525` | `#EDF0F6` | The primary action is Ink, near-white in the dark theme. |
| `color.action.primaryHover` | `#1C2539` | `#DDE2EC` | Hovered Primary. Derived. |
| `color.action.primaryPressed` | `#26304A` | `#C3CAD7` | Pressed Primary. Derived. |
| `color.action.primaryText` | `#FFFFFF` | `#0E1525` | Text on Primary. |
| `color.action.secondary` | `#FFFFFF` | `#10151F` | Secondary fill: the surface. |
| `color.action.secondaryText` | `#0E1525` | `#EDF0F6` | Text on Secondary: the primary text. |
| `color.action.disabled` | `#EEF0F4` | `#1B2230` | A disabled button. Derived. |
| `color.action.disabledText` | `#8A94A8` | `#667085` | Text on a disabled button; exempt from contrast. Derived. |
| `color.action.new` | `#BE1E2D` | `#F04B59` | The New button in the top bar: the brand crimson. |
| `color.action.newHover` | `#A91A28` | `#F25F6B` | Hovered New. Dark value derived. |
| `color.action.newPressed` | `#94151F` | `#F5808A` | Pressed New. Derived. |
| `color.action.newText` | `#FFFFFF` | `#0E1525` | Text on New: white on the crimson, Ink on the lighter dark-theme crimson. Dark value derived. |

Secondary and Danger have no fill token of their own for hover and pressed: hover is `surface.subtle` (a soft Danger fill for Danger) and pressed is `--button-pressed-background`, a recorded component token (§3.3) of `#E2E5EB` in the light theme and `#090D16` in the dark (§4.6).

### Focus

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `focus.ring` | `#2563A6` | `#7AA7F0` | The focus ring. |
| `focus.offset` | `#FFFFFF` | `#10151F` | The band between the ring and the control: the surface. Dark value derived. |
| `focus.ringInverse` | `#FFFFFF` | `#FFFFFF` | The ring on the sidebar. |
| `focus.offsetInverse` | `#0E1525` | `#0C111A` | The band on the sidebar: the sidebar itself. |

| Token | Value |
|---|---:|
| `focus.width` | `2px` |
| `focus.offsetWidth` | `2px` |

Focus styling must be visible without depending on hover.

Do not remove browser focus treatment unless an equal or stronger custom focus indicator replaces it.

### Sidebar

The sidebar is `surface.inverse`, an Ink ground in both themes, and these tokens are what is drawn on it (§4.6, §22). They keep the `shell` names they had as aliases of the old palette.

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `shell.text` | `#FFFFFF` | `#FFFFFF` | Hovered item text, the product name and the account name. |
| `shell.textMuted` | `#C3CAD7` | `#C3CAD7` | Idle item text. |
| `shell.textSubtle` | `#8A94A8` | `#8A94A8` | Secondary text: the application name, the account's hub. |
| `shell.surfaceHover` | `#1C2539` | `#1C2539` | A hovered item. |
| `shell.surfacePressed` | `#26304A` | `#26304A` | A pressed item and the account avatar. Derived. |
| `shell.border` | `#1C2539` | `#1C2539` | Dividers on Ink; not a control boundary. |
| `shell.active` | `#BE1E2D` | `#BE1E2D` | The active item: a solid crimson fill in both themes. |
| `shell.activeText` | `#FFFFFF` | `#FFFFFF` | Text on the active item, set bold. |
| `shell.activeHover` | `#A91A28` | `#A91A28` | The hovered active item. |
| `shell.activeBadge` | `rgb(255 255 255 / 0.18)` | `rgb(255 255 255 / 0.18)` | The pill of a count on the active item: white at 18% over the crimson, with the figure in `shell.activeText` (4.63 on `shell.active`, 5.31 on `shell.activeHover`; at 22% the figure would be 4.32, below the 4.5 that text of its size needs, and the Product Owner accepted 18% on 6 November 2026). A component token, held to those numbers by the test "the pill of a count on the current entry of the sidebar" in `scripts/design-tokens.test.ts`. |

### How the unlisted values were derived

- **Hover and pressed fills** step away from the resting fill in the direction the text on it allows. Primary lightens toward the sidebar's tones in the light theme (`#1C2539`, `#26304A`) and dims toward the sidebar's text tone in the dark theme (`#DDE2EC`, `#C3CAD7`). New darkens in the light theme, from the Product Owner's active-item hover (`#A91A28`) to `#94151F`, and lightens in the dark theme, because its text is Ink there and white on `#F04B59` would be 3.59:1.
- **Disabled** controls reuse palette values, and their text is exempt from contrast, as WCAG allows for an inactive control (§4.6).
- **`surface.selected`** is an Ink tint, because crimson is not for selection (§4.7). The dark value is the lightest tint on which a hovered link (`text.linkHover`) still reaches 4.5:1.
- **`border.strong`** is the value of `text.muted`, which is at least 3:1 on every surface that supports a boundary (§4.6).
- **Status borders** (§4.4) are the foreground mixed into the background: 30% in the light theme, 35% in the dark. They are decoration; the text and the icon carry the meaning.
- **`focus.offset`** in the dark theme is the dark surface, so that the band separates the ring from a control as it does in the light. **`shell.surfacePressed`** is the Primary pressed fill of the light theme, which is a step beyond `shell.surfaceHover`.

**Approved as built (Product Owner, 5 November 2026, in the task of redesign step R3).** The values step R2 derived, as this section lists them, the 44px controls (§11), the 36px rows (§10) and the single floating shadow (§8).

---

## 4.4 Status tokens

Status tokens must be semantic and independent of domain enum names. Each of the five has a foreground, a background and a border in each theme. The names are unchanged; the Product Owner's words for them are in the Role column.

| Token | Light | Dark | Role |
|---|---:|---:|---|
| `color.status.warning.foreground` | `#8A4F00` | `#F0B45A` | Waiting: text and icon. |
| `color.status.warning.background` | `#FFF3E0` | `#2E2210` | Waiting: fill. |
| `color.status.warning.border` | `#DCC29D` | `#72552A` | Waiting: edge. |
| `color.status.success.foreground` | `#0B6B44` | `#5CCB95` | Done: text and icon. |
| `color.status.success.background` | `#E7F6EF` | `#0F2A1F` | Done: fill. |
| `color.status.success.border` | `#A5CCBC` | `#2A6248` | Done: edge. |
| `color.status.info.foreground` | `#1F4E96` | `#86B1F4` | In progress: text and icon. |
| `color.status.info.background` | `#EAF1FB` | `#12223C` | In progress: fill. |
| `color.status.info.border` | `#ADC0DD` | `#3B547C` | In progress: edge. |
| `color.status.neutral.foreground` | `#475066` | `#A9B2C3` | Neutral: text and icon. |
| `color.status.neutral.background` | `#EEF0F4` | `#1B2230` | Neutral: fill. |
| `color.status.neutral.border` | `#BCC0C9` | `#4D5463` | Neutral: edge. |
| `color.status.danger.foreground` | `#A8320E` | `#FF8A66` | Danger: text and icon. |
| `color.status.danger.background` | `#FDEDE7` | `#33170F` | Danger: fill. |
| `color.status.danger.border` | `#E4B5A6` | `#7A3F2D` | Danger: edge. |

Status colors must always be accompanied by readable text and, where useful, icons or explicit labels. Danger is a separate vermilion and never crimson (§4.7).

---

## 4.5 Verified contrast baseline

The following working combinations have suitable contrast for normal text, nine in each theme.

### Light theme

| Foreground | Background | Approx. contrast |
|---|---|---:|
| `#BE1E2D` | `#FFFFFF` | 6.15:1 |
| `#0E1525` | `#FFFFFF` | 18.22:1 |
| `#626B81` | `#FFFFFF` | 5.33:1 |
| `#0B6B44` | `#E7F6EF` | 5.88:1 |
| `#8A4F00` | `#FFF3E0` | 5.99:1 |
| `#A8320E` | `#FDEDE7` | 5.90:1 |
| `#1F4E96` | `#EAF1FB` | 7.14:1 |
| `#475066` | `#EEF0F4` | 7.06:1 |
| `#475066` | `#F3F4F7` | 7.32:1 |

### Dark theme

| Foreground | Background | Approx. contrast |
|---|---|---:|
| `#F04B59` | `#10151F` | 5.10:1 |
| `#EDF0F6` | `#10151F` | 16.01:1 |
| `#8E98AC` | `#10151F` | 6.30:1 |
| `#5CCB95` | `#0F2A1F` | 7.61:1 |
| `#F0B45A` | `#2E2210` | 8.42:1 |
| `#FF8A66` | `#33170F` | 7.15:1 |
| `#86B1F4` | `#12223C` | 7.28:1 |
| `#A9B2C3` | `#1B2230` | 7.47:1 |
| `#0E1525` | `#EDF0F6` | 15.96:1 |

These pairs are individually verified. They do not make other combinations of the same tokens accessible:
§4.6 lists the combinations the system supports. Ratios in this document are computed from the hex values with the
WCAG 2.x relative-luminance formula and shown to two decimals; a ratio below its threshold is never rounded up to pass.
The thresholds are 4.5:1 for normal text and 3:1 for large text and for the visual cues that identify a control or its
state.

Every new color pairing introduced later must be checked independently and added to §4.6 before it is used.

---

## 4.6 Supported pairings and state recipes

Tokens are not freely combinable. A foreground, border or focus colour is supported only on the surfaces listed here;
a combination that is not listed is not supported. `✗` is below the threshold for the use named, and `thin` passes by
less than 0.25 and is supported only where the rule below says so. Every table is written once for each theme, and the
same pairings are supported in both.

### Text on surfaces, light theme

| Foreground | `surface.default` `#FFFFFF` | `surface.page` `#F3F4F7` | `surface.raised` `#F8F9FB` | `surface.subtle` `#EEF0F4` | `surface.selected` `#E2E5EB` | `surface.inverse` `#0E1525` |
|---|---:|---:|---:|---:|---:|---:|
| `text.primary` `#0E1525` | 18.22 | 16.57 | 17.29 | 15.97 | 14.44 | ✗ 1.00 |
| `text.secondary` `#475066` | 8.05 | 7.32 | 7.65 | 7.06 | 6.38 | ✗ 2.26 |
| `text.muted` `#626B81` | 5.33 | 4.85 | 5.06 | 4.67 thin | ✗ 4.22 | ✗ 3.42 |
| `text.link` `#0E1525` | 18.22 | 16.57 | 17.29 | 15.97 | 14.44 | ✗ 1.00 |
| `text.linkHover` `#BE1E2D` | 6.15 | 5.59 | 5.84 | 5.39 | 4.88 | ✗ 2.96 |
| `text.inverse` `#FFFFFF` | ✗ 1.00 | ✗ 1.10 | ✗ 1.05 | ✗ 1.14 | ✗ 1.26 | 18.22 |

- `text.muted` is for supporting copy on `surface.default`, `surface.page`, `surface.raised` and `surface.subtle`. On
  `surface.subtle` it passes by 0.17, so it is the thinnest; on `surface.selected` it
  fails (4.22), so use `text.secondary` or `text.primary` there.
- `text.inverse` is for `surface.inverse`, nowhere else. A filled action has a text token of its own (`action.primaryText`, `action.newText`).
- `text.disabled` (`#8A94A8`) is 3.05:1 on white. WCAG exempts inactive
  controls from contrast, so it is allowed only on a control that is really disabled (native `disabled`), and what it shows
  must be available elsewhere. A disabled state is never conveyed by this colour alone.
- Links are underlined in running text. `text.link` is `text.primary`, so colour does not identify a link at all: the
  underline does. A hovered link takes the brand crimson, `text.linkHover`, which reaches 4.5:1 on every light surface
  (4.88 on `surface.selected`, the thinnest).

### Text on surfaces, dark theme

| Foreground | `surface.default` `#10151F` | `surface.page` `#090D16` | `surface.raised` `#141A26` | `surface.subtle` `#0C111A` | `surface.selected` `#16202F` | `surface.inverse` `#0C111A` |
|---|---:|---:|---:|---:|---:|---:|
| `text.primary` `#EDF0F6` | 16.01 | 17.02 | 15.26 | 16.56 | 14.35 | 16.56 |
| `text.secondary` `#A9B2C3` | 8.57 | 9.11 | 8.17 | 8.86 | 7.68 | 8.86 |
| `text.muted` `#8E98AC` | 6.30 | 6.70 | 6.00 | 6.52 | 5.65 | 6.52 |
| `text.link` `#EDF0F6` | 16.01 | 17.02 | 15.26 | 16.56 | 14.35 | 16.56 |
| `text.linkHover` `#F04B59` | 5.10 | 5.42 | 4.86 | 5.27 | 4.57 thin | 5.27 |
| `text.inverse` `#FFFFFF` | 18.28 | 19.43 | 17.42 | 18.91 | 16.38 | 18.91 |

- Every text token reaches 4.5:1 on every dark surface; `text.linkHover` on `surface.selected`
  (4.57) is the thinnest, which is why the selected tint is no lighter.
- `text.inverse` is white on every dark surface, as on the light theme's sidebar; it is still for `surface.inverse` only.
  Primary's text is `action.primaryText`, which is Ink on the near-white fill.
- `text.disabled` is exempt on a control that is really disabled, as in the light theme.

### Control boundary, light theme

A text field is identified by its boundary, so the boundary must reach 3:1 against the surface the control sits on
(WCAG 1.4.11).

| Foreground | `surface.default` `#FFFFFF` | `surface.page` `#F3F4F7` | `surface.raised` `#F8F9FB` | `surface.subtle` `#EEF0F4` | `surface.selected` `#E2E5EB` |
|---|---:|---:|---:|---:|---:|
| `border.control` `#7C859A` | 3.70 | 3.36 | 3.51 | 3.24 thin | ✗ 2.93 |
| `border.strong` `#626B81` | 5.33 | 4.85 | 5.06 | 4.67 | 4.22 |
| `border.default` `#C9CED8` | ✗ 1.58 | ✗ 1.44 | ✗ 1.50 | ✗ 1.38 | ✗ 1.25 |
| `border.subtle` `#E2E5EB` | ✗ 1.26 | ✗ 1.15 | ✗ 1.20 | ✗ 1.11 | ✗ 1.00 |

- `border.control` is supported on `surface.default`, `surface.page`, `surface.raised` and `surface.subtle`, where its
  thinnest margin is 3.24. On `surface.selected` it fails
  (2.93), so use `border.strong` there. `border.strong` stays the boundary where
  more emphasis is wanted.
- `border.default` and `border.subtle` are structural and decorative. They are never the only boundary of an input. A
  button is identified by its label, so `border.default` on a Secondary button is allowed.

### Control boundary, dark theme

| Foreground | `surface.default` `#10151F` | `surface.page` `#090D16` | `surface.raised` `#141A26` | `surface.subtle` `#0C111A` | `surface.selected` `#16202F` |
|---|---:|---:|---:|---:|---:|
| `border.control` `#667085` | 3.67 | 3.91 | 3.50 | 3.80 | 3.29 |
| `border.strong` `#8E98AC` | 6.30 | 6.70 | 6.00 | 6.52 | 5.65 |
| `border.default` `#333D4F` | ✗ 1.67 | ✗ 1.78 | ✗ 1.59 | ✗ 1.73 | ✗ 1.50 |
| `border.subtle` `#222A38` | ✗ 1.27 | ✗ 1.35 | ✗ 1.21 | ✗ 1.31 | ✗ 1.14 |

- `border.control` is supported on all five dark surfaces; the thinnest is 3.29
  on `surface.selected`. `border.default` and `border.subtle` are structural, as in the light theme.

### Focus, light theme

| Foreground | `surface.default` `#FFFFFF` | `surface.page` `#F3F4F7` | `surface.raised` `#F8F9FB` | `surface.subtle` `#EEF0F4` | `surface.selected` `#E2E5EB` | `surface.inverse` `#0E1525` |
|---|---:|---:|---:|---:|---:|---:|
| `focus.ring` `#2563A6` | 6.15 | 5.59 | 5.84 | 5.39 | 4.87 | ✗ 2.96 |
| `focus.ringInverse` `#FFFFFF` | ✗ 1.00 | ✗ 1.10 | ✗ 1.05 | ✗ 1.14 | ✗ 1.26 | 18.22 |

- **Default recipe**, on every light surface: a 2px `focus.ring` outside a 2px band of `focus.offset` (white), so the
  indicator is also separated from a filled control such as Primary (white against Ink is 18.22:1).
- **Inverse recipe**, on `surface.inverse`: a 2px `focus.ringInverse` outside a 2px band of `focus.offsetInverse` (the
  sidebar itself). A blue ring on Ink is only 2.96:1, so the default recipe is not used there.
- Draw the indicator with `outline` so that forced-colors mode keeps it (it drops `box-shadow`). Do not clip it with
  `overflow: hidden`, and do not let a sticky region hide the focused control entirely (§14).

### Focus, dark theme

| Foreground | `surface.default` `#10151F` | `surface.page` `#090D16` | `surface.raised` `#141A26` | `surface.subtle` `#0C111A` | `surface.selected` `#16202F` | `surface.inverse` `#0C111A` |
|---|---:|---:|---:|---:|---:|---:|
| `focus.ring` `#7AA7F0` | 7.50 | 7.97 | 7.15 | 7.75 | 6.72 | 7.75 |
| `focus.ringInverse` `#FFFFFF` | 18.28 | 19.43 | 17.42 | 18.91 | 16.38 | 18.91 |

- The default recipe in the dark theme is a 2px `focus.ring` outside a 2px band of `focus.offset`, the dark surface, so the
  ring is separated from the near-white Primary fill. The inverse recipe is unchanged: the sidebar is a dark ground in both
  themes.

### Selected, inverse and status

- `surface.selected` supports `text.primary`, `text.secondary`, `text.link`, `text.linkHover` and
  `status.danger.foreground` in both themes. A selected row is marked by more than its tint: a leading `color.action.primary`
  bar (14.44 against the tint in the light theme, 14.35
  in the dark, which exceeds the 3:1 a graphical cue needs) and the semantic state (`aria-current` or `aria-selected`).
- **Ink sidebar (the authenticated Ops shell only, §13.1).** It is `surface.inverse`: Ink in the light theme and
  `#0C111A` in the dark. Idle items are `shell.textMuted` (11.06 on Ink,
  11.48 on the dark sidebar); hovered, `shell.text` on `shell.surfaceHover`
  (15.29); pressed, on `shell.surfacePressed` (13.09);
  secondary text (the application's name, the account's hub) is `shell.textSubtle` (5.97
  on Ink, 6.20 on the dark sidebar, 5.01 on hover);
  dividers are `shell.border`.
- **A count beside an item of the sidebar** (the `CountBadge` on `surface="shell"`, task C1, 5 November 2026) takes the shell's own tokens: the number is `shell.text` on `shell.surfacePressed` (13.09), with `shell.border` for its edge; a count of `0` that was read is quiet, `shell.textSubtle` on Ink with no fill (5.97 on Ink, 6.20 on the dark sidebar). On the **current item** the badge is a pill of white at 18% over the crimson (`shell.activeBadge`, the one colour this badge adds), with the figure in `shell.activeText`: 4.63 on `shell.active` and 5.31 on `shell.activeHover`, in both themes, so that it stays apart from the item's own hovered ground (at 22% the figure measures 4.32, below the 4.5 that text of its size needs). A quiet `0` there is a ring of `shell.activeText` on `shell.active` (6.15). The words that say what the number counts are for a screen reader and are not drawn. On the page it is the neutral status pair of §4.4, and a quiet `0` is `text.secondary` without the fill; no screen draws it there yet (My work sets its figures in its own face).
- **The current item** of the sidebar is a filled item and not a bar: `shell.active`, crimson, with `shell.activeText`, white
  (6.15), and `shell.activeHover` when hovered (7.33).
  It is written in weight 700 with `aria-current`, so the state is carried by the white text on the fill, the weight and the
  attribute, and the fill supports them (its edge against Ink is 2.96, and
  3.07 on the dark sidebar, which is why it is never the only cue). Focus is the inverse recipe and holds 3:1 on each of
  those fills (18.22 on Ink, 15.29 hovered,
  13.09 pressed, 6.15 active,
  7.33 active and hovered).
- Status text pairs (foreground on its own soft background, on `surface.default`, on `surface.page`), light theme: warning 5.99, 6.56, 5.97; success 5.88, 6.56, 5.97; info 7.14, 8.11, 7.38; neutral 7.06, 8.05, 7.32; danger 5.90, 6.71, 6.11.
  Dark theme: warning 8.42, 9.90, 10.53; success 7.61, 9.08, 9.65; info 7.28, 8.36, 8.89; neutral 7.47, 8.57, 9.11; danger 7.15, 7.90, 8.40. Status borders are decoration, 1.5 to 1.9:1 in the light theme and 2.0 to 2.7:1 in
  the dark; the text and the icon carry the meaning.

### State recipes for the initial components

Tokens only (written without the `color.` prefix of §4.3); the ratio is the text against its fill, light theme then dark
theme.

| Component, state | Fill | Text | Boundary and notes |
|---|---|---|---|
| Primary: default, hover, pressed | `action.primary`, `primaryHover`, `primaryPressed` | `action.primaryText` (18.22, 15.29, 13.09; dark 15.96, 14.02, 11.06) | focus: default recipe |
| Primary: disabled | `action.disabled` | `action.disabledText` (exempt, 2.67; dark 3.20) | native `disabled`; loading keeps the label and the colours |
| Secondary: default, hover, pressed | `action.secondary`, `surface.subtle`, `--button-pressed-background` | `action.secondaryText` (18.22, 15.97, 14.44; dark 16.01, 16.56, 17.02) | `border.default` (decorative) |
| Tertiary: default, hover, pressed | none, `surface.subtle`, `--button-pressed-background` | `text.link`, `text.linkHover`, `text.linkHover` (18.22 on white, 5.39 and 4.88 on the hover and pressed fills; dark 16.01, 5.27, 5.42) | no border |
| New: default, hover, pressed | `action.new`, `newHover`, `newPressed` | `action.newText` (6.15, 7.33, 8.80; dark 5.08, 5.75, 7.23) | the brand crimson, in the top bar; focus: default recipe |
| Danger (outline; approved 24 October 2026) | `surface.default`, `status.danger.background`, `--button-pressed-background` | `status.danger.foreground` (6.71, 5.90, 5.32; dark 7.90, 7.15, 8.40) | wording names the consequence; the recipe is the outline and no filled Danger button is part of the system (§16.3) |
| Link: default, hover | none | `text.link`, `text.linkHover` | underlined in running text; no separate visited colour until a screen needs one |
| Input: default, hover | `surface.default` | `text.primary`; placeholder `text.muted` (5.33; dark 6.30) | `border.control` (`border.strong` on `surface.selected`); hover `border.strong` |
| Input: invalid | `surface.default` | `text.primary`; message `status.danger.foreground` (6.71; dark 7.90) | 2px `status.danger.foreground` border and an icon and the message and `aria-invalid`; never the red border alone |
| Input: read-only | `surface.subtle` | `text.primary` (15.97; dark 16.56) | `border.strong` (4.67; dark 6.52); value stays selectable; not styled as disabled |
| Input: disabled | `surface.disabled` | `text.disabled` (exempt) | `border.disabled`; native `disabled` |
| Alert, all five variants | `status.<variant>.background` | `status.<variant>.foreground` | `status.<variant>.border`, an icon and the text; an action link uses the foreground, underlined |

**Acceptance.** Examples on default, page, raised, subtle, selected and inverse surfaces, in both themes, with the whole
focus geometry visible (a screenshot is part of the evidence). A test reads the token source and asserts that every
pairing listed in this section meets its threshold in both themes, so a later token change cannot silently break one. A
failing ratio is never rounded up.

---

## 4.7 Colour roles

**Ink carries the work, crimson carries the brand** ([BRAND_FOUNDATION §5.5](BRAND_FOUNDATION.md#55-color-usage-principle)). The values are in §4.3 and §4.4; this section says what each role is for.

- The primary action is Ink, one per view. In the dark theme it is near-white with Ink text.
- Crimson is the brand mark, the "New" button and the active sidebar item, a solid crimson fill with white bold text. A small crimson square, taken from the logo, marks the active hub and the current step. Nothing else is crimson: not a selected row, not a link, not an error.
- Danger is a separate vermilion, never crimson, and is always placed last.
- Links are Ink, not crimson. The underline tells a link (§4.6); a hovered link takes the brand crimson.
- Neutrals are tinted toward Ink, not stock grays.
- Crimson `#BE1E2D` is the logo red (§4.1). In the dark theme the brand crimson is the lighter `#F04B59`, while the sidebar's active fill stays `#BE1E2D` with white text, because the sidebar is the same Ink ground in both themes.
- A theme is a second set of values for the same names (§31). A component never asks which theme is in force.

---

## 5. Typography

## 5.1 Typeface

The product UI has two typefaces, both self-hosted by the Ops Portal. **Inter**, approved by the Product Owner on 6 October 2026, is the typeface of everything people read. **JetBrains Mono**, approved on 5 November 2026 and shipped since step R2, is for operational codes only (a code such as `HUB-TT-XXXXXX`), so that a code read aloud never blurs.

The stack below shows while a font file loads and for any character Inter does not cover. It is the value of `--font-family-sans`:

```text
Inter,
ui-sans-serif,
system-ui,
-apple-system,
BlinkMacSystemFont,
"Segoe UI",
sans-serif
```

The stack for a code is the value of `--font-family-mono`:

```text
"JetBrains Mono",
ui-monospace,
"SFMono-Regular",
Menlo,
Consolas,
"Liberation Mono",
monospace
```

How they are shipped (`apps/ops-web`; held by `test/fonts.test.ts`, `test/build.test.ts` and the browser tests):

- the files are committed under `src/assets/fonts/`, never hot-linked from a CDN. `fonts.json` there records, for each family, the
  version, where the files came from and the SHA-256 of each file, and each family's SIL Open Font License 1.1 text ships with the
  build, byte for byte, at `/licenses/Inter-OFL.txt` and `/licenses/JetBrainsMono-OFL.txt`;
- Inter is a variable font. The Latin and Latin Extended subsets are shipped, one file each, and the browser fetches a
  subset only when the page holds a character of its `unicode-range`. They are declared for weights 400 to 600, the range
  of the type scale (§5.2). Other scripts use the stack above until a requirement names them;
- JetBrains Mono is a variable font too, and only its Latin subset is shipped, declared for weights 500 and 600. A character
  outside it shows in the next face of its stack;
- a component takes the monospace face through `--font-family-mono` and never names it: `test/fonts.test.ts` fails on a
  stylesheet, other than the token file and `fonts.css`, that does. Numbers are set in tabular figures everywhere (§5.2), in either face;
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
- Numbers use tabular numerals everywhere (decided 5 November 2026): `font-variant-numeric: tabular-nums` is set in the base type (`base.css`), so that a column of counts, times and amounts lines up, and a test says so.
- **Sizes the signed-in shell sets outside this scale** (the Product Owner's brief for redesign step R4, 6 November 2026; built on 7 November and awaiting acceptance, COMPONENT_PATTERNS §12.6). The title of a page inside the shell is 24px on a 30px line, weight 700 and 0.02em tighter, where `text.heading.xl` above is 28/36/600 (the title of the neutral frame and of the pre-sign-in pages keeps `text.heading.xl`). The sidebar's entries are 13.5px at weight 500, and 700 on the current entry. The headings of the sidebar's groups are 11px, weight 600, in capitals, 0.08em apart; the labels of the sections of My work and of the top bar's menus are 11.5px, weight 600, in capitals, 0.06em apart; the key hint of the search is 11px; the figure on a card of My work is 32px at weight 700. The three sizes under 12px depart from the first rule and the bold weights from the second: they are labels and hints that name a group or a shortcut and never carry the information themselves, and they are written here so that the departure is on record and does not spread. **Decided on 7 November 2026 (the audit of the redesign): they are tokens, and the number is written once.** The sizes that are not the scale's are component tokens of `tokens.css` (§3.3), each named for the one component that uses it and in `rem`: `--text-nav-entry-size` (the name of a sidebar entry), `--text-group-label-size` and its line height (a group's heading, and the key hint of the search), `--text-section-label-size` and its line height (the labels of the sections of the menus and of My work), `--sidebar-icon-size`, `--sidebar-heading-space-before` and `--sidebar-heading-space-after`, and `--hub-mark-size` (the hub switcher's square); the figure on a card of My work takes `text.display.sm`'s 32px on 40px at weight 700. `scripts/design-tokens.test.ts` records each as a component token with its reason, and no stylesheet of a component carries these numbers.

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
| `radius.sm` | `4px` | compact marks: status badges, calendar days, skeletons |
| `radius.md` | `8px` | controls: inputs and buttons |
| `radius.lg` | `12px` | panels: cards, dialogs, popovers, the record panel |
| `radius.xl` | `16px` | page cards |
| `radius.full` | `9999px` | avatars/status dots/pills only where appropriate |

Avoid applying `radius.full` to ordinary controls merely for decoration.

Decided by the Product Owner on 5 November 2026: 8px for controls, 12px for panels and 16px for page cards.

---

## 8. Elevation

Prefer borders and surface contrast before shadows. There is one soft shadow, and it is only for things that float: menus, popovers, dialogs, the record panel and toasts (Product Owner, 5 November 2026). Everything else is flat.

| Token | Light | Dark | Use |
|---|---|---|---|
| `shadow.none` | `none` | `none` | normal flat structure |
| `shadow.floating` | `0 8px 24px rgb(14 21 37 / 0.12)` | `0 8px 24px rgb(0 0 0 / 0.5)` | floating surfaces only |

The shadow tints toward Ink in the light theme. On a dark ground a light shadow cannot be seen, so the dark value is black and heavier. Avoid deeper decorative shadows.

---

## 9. Motion

Motion should explain state change rather than decorate.

### Working durations and easing

| Token | Value | Use |
|---|---:|---|
| `motion.fast` | `120ms` | hover and press |
| `motion.normal` | `200ms` | menus, popovers and the tab underline |
| `motion.slow` | `280ms` | the record panel and sheets |
| `motion.highlight` | `900ms` | a changed row, which highlights once |
| `motion.easeEnter` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | to enter |
| `motion.easeExit` | `cubic-bezier(0.4, 0, 1, 1)` | to leave, about 30% faster |

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

Motion confirms what happened (Product Owner, 5 November 2026).

- Success lands as a toast.
- Under `prefers-reduced-motion: reduce` every duration token is `0ms`: the token file sets them to zero, so nothing that takes its duration from a token moves. The easings are not durations and are left alone. Motion whose length does not come from a token (a spinner, a keyframe with a length of its own) still needs its own reduced-motion rule.

---

## 10. Density system

Melarc uses three task-oriented density contexts.

Rows and controls come in three heights (Product Owner, 5 November 2026). They are the control heights of §11 under the names a row is given, so that a queue row is not mistaken for a control:

| Token | Value | Use |
|---|---:|---|
| `density.row.compact` | `36px` | desk queue rows |
| `density.row.standard` | `44px` | form controls and list rows |
| `density.row.touch` | `56px` | tablet rows (§12) |

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
row height: 36px at the desk (density.row.compact), 56px on a tablet (density.row.touch, §12)
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
| `sm` | `36px` | dense desktop-only control and desk queue row |
| `md` | `44px` | default web control: forms |
| `lg` | `56px` | touch: hub-floor tablet controls and rows (§12) |

Default:

```text
button = md
input  = md
select = md
```

Do not use 36px controls on touch-dominant screens.

The three heights are `density.row.compact`, `density.row.standard` and `density.row.touch` (§10).

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

### Devices (Product Owner, 5 November 2026)

Desk work (queues, records, administration) is desktop-first ([surfaces/ops-portal.md](../surfaces/ops-portal.md#11-responsive-device-baseline-and-accessibility) §11). **Hub-floor tasks** (intake, blind count, itemization, discrepancies, cash and parcel handovers) are designed tablet-first at 768px: 56px touch rows and one task per screen. At 768px the record panel becomes a full-screen sheet and the sidebar collapses to icons.

---

## 13. Layout rules

### 13.1 Layout families

The Ops Portal has three layouts, and the route tree chooses between them. They are not one component with optional
parts, because a pre-authentication page must never be able to show a signed-in affordance
([surfaces/ops-portal.md](../surfaces/ops-portal.md) §7).

| Layout | Route family | Contains | Never contains | In code |
|---|---|---|---|---|
| **Neutral frame** | any address that matches no route, and the development showcase | a skip link, a banner that names the product, the main landmark, the move of focus to the new page's heading after a navigation | navigation, a user menu, sign-out, session data, anything loaded for a signed-in user | `apps/ops-web/src/app/AppFrame.tsx` |
| **Authenticated Ops shell** | the signed-in routes (§7 of the Ops spec), and only those | the skip link and the landmarks, an **Ink sidebar** docked at the left (the primary navigation, in groups, and the person at its foot), the 64px rail below 1280px and on request and a sheet on a narrow screen, and over the page a **top bar of 56px**, which is the page's banner (the hub switcher, the search, the theme, the New menu and the account menu with the sign-out control); no banner above the page, because the sidebar carries the product's name | content for a caller who has no session | the frame in its sidebar layout, the sidebar and the top bar drawn into the frame's own places (`apps/ops-web/src/app/AuthenticatedOpsShell.tsx`, `app/shell/`, `components/ui/app-shell/`; [COMPONENT_PATTERNS.md](COMPONENT_PATTERNS.md) §12.6). It was a band across the top until 25 October 2026, when the Product Owner decided that the Ops Portal is an application and not a website, and a side menu with an account card until redesign step R4 |
| **Split-screen layout** | the five pre-sign-in routes (`/sign-in`, `/sign-in/mfa`, `/setup/credential`, `/setup/mfa`, `/setup/mfa/complete`), and the two recovery routes when they are built; the setup routes are reached by a grant and carry no session | the skip link and the landmarks, the banner (the logo) above the main landmark that holds the form, and beside them a decorative panel of photography over a band of Ink with the mark and the name (§13.1a); under 64rem the panel is not drawn and the form is alone | the authenticated shell, navigation, anything loaded for a signed-in user | the frame in its split layout (`AuthSplitLayout`), its banner and main landmark unchanged; the five pre-sign-in screens (the sign-in pair and the three setup pages) are in `apps/ops-web/src/app/pages/pre-sign-in/` (S0.43; [COMPONENT_PATTERNS.md](COMPONENT_PATTERNS.md) §12.7) |

- The route tree chooses the layout; a page never decides which frame it sits in.
- Every layout keeps the skip link, the landmarks and the focus move after a navigation.
- A pre-authentication page shows no authenticated affordance in any state: loading, challenge, error or success. A
  `202` MFA challenge is not a session, so it renders in the neutral frame and shows no signed-in UI.
- An error or not-found page renders inside the layout of its route family. An address that matches no route belongs
  to none, and uses the neutral frame, because that page cannot know whether a session exists.
- A generic restyle does not wrap every route in the Ink shell.
- The authenticated shell should feel spacious and stable; the neutral frame is quiet, with no Ink navigation.
- **Approved direction (Product Owner, 5 November 2026), built in step R4 (7 November 2026; awaiting the Product Owner's acceptance):** the signed-in shell gains a top bar over the main content (the hub switcher, a global search, the theme control, a New menu and the account menu; on a narrow screen the theme is chosen in the account menu instead), the sidebar shows seven groups, and the account menu says who is signed in and where they act, beside the sidebar's foot, which still names the person. The structure is [the Ops surface's](../surfaces/ops-portal.md#4-navigation-model); the table above is the shell as built.

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
- The token test, `scripts/design-tokens.test.ts`: the token file equals this document in each theme, the two themes are
  built as §31 says (the two dark blocks say the same, `color-scheme` follows the theme, reduced motion zeroes the
  durations), every pairing the components use meets its threshold from the file's own values in both themes, no colour
  is written outside the file, and every focus rule draws an outline. The contrast test, `scripts/design-contrast.test.ts`,
  recomputes every figure of §4.5 and §4.6 for both themes.
- The browser tests, `apps/ops-web/test/browser/`: `shell.spec.ts` against the production build and `components.spec.ts`
  against the development-only showcase. They run axe with the WCAG 2.2 tags, so contrast and `target-size` are checked
  with layout, at 1280, 768 and 320 px; no sideways scrolling at those widths; keyboard order, Enter and Space, and the
  focus ring on every stop; text enlarged to 200%; forced colours (not WebKit, which Playwright cannot emulate) and
  reduced motion; and a failed submit that moves focus to the first invalid field. `components.spec.ts` also runs the
  scan in the dark theme (by the system setting at 1280 and 320 px, and by `data-theme="dark"` on a light system) and
  proves that the dark values reach the page as §31 says.
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

Do not reuse the primary button token for it. The separation is complete: the primary action is Ink, and danger is a separate vermilion, never crimson, and is always placed last (§4.7).

Danger actions require explicit destructive wording.

---

## 17. Links

Links should:

- remain visually distinguishable from body text;
- have hover/focus treatment;
- not rely solely on color where ambiguity exists;
- use normal link semantics for navigation rather than button semantics.

Do not style every navigation action as a button.

Links are Ink, not crimson (approved 5 November 2026, §4.7). The underline in running text, and not the color, tells a link (§4.6).

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

**It is a sidebar, not a band across the top** (Product Owner, 25 October 2026: the Ops Portal is an application and not a
website; built in its present form in redesign step R4, 7 November 2026). Docked at the left, full height, on Ink, 248px wide with the
all-white lockup at its head; a button at its head collapses it to the 64px rail of icons and expands it again, and every entry keeps its
name on the rail (visually hidden in the entry, and shown in a tooltip on hover and on focus). It is the rail below 1280px and the full
sidebar from there, unless the person asked for the other, and under 48rem it is a sheet: a modal dialog that slides in over the page when
the top bar's menu button is pressed; the page behind it is hidden from assistive technology, Escape, the scrim, the close button and
following a link close it, and focus goes in on opening and back on closing. **The current entry is a solid crimson fill with white bold
text** and `aria-current="page"`. Its foot names the person and where they act. The choice of the rail or the full width is kept while the
page lives and not longer (nothing is written to web storage).

**Approved direction (Product Owner, 5 November 2026; built in step R4).** The sidebar shows seven groups in the order of the hub's day, each only when the session holds a key for one of its built pages, and a queue entry carries a live count where the server states one. What the account card held (the person's name and hubs, the trusted browsers, sign-out) is in an account menu in a top bar that also holds the hub switcher, a global search, the theme control and a New menu. The groups, the entries and the top bar are [the Ops surface's](../surfaces/ops-portal.md#4-navigation-model); how they are drawn is this document's and, for the components, [COMPONENT_PATTERNS §12.6](COMPONENT_PATTERNS.md#126-the-authenticated-ops-shell-as-built-s042-the-sidebar-and-the-top-bar-since-redesign-step-r4)'s.

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

As built: the current entry is a filled item (§4.6), crimson (`shell.active`) with white bold text, and an icon and its name;
the icon is the one the landing gives the same place, so one meaning has one picture. The primary action is Ink, so the
current item no longer uses it (§4.7).

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
tokens alone, the content-security policy of §29.4 respected, the accessibility baseline (§14) met, a licence that ships with the build. Only if no grid serves
the screen is the behavior built here. Either way it is a new pattern (COMPONENT_PATTERNS §37) and a change of technical foundation,
surfaced before it is built ([PRODUCT_DESIGN_DIRECTION §7](PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision)).

**Decided (Product Owner, 5 November 2026) and adopted in redesign step R3: TanStack Table.** The specialist grid for the queue data model is TanStack Table (headless; 8.21.3, an exact pin: version 8 is the line the shadcn/ui data-table pattern is written for, and 9 is a new major that is not adopted), over the shadcn/ui `table` primitive (§29.2), behind a Melarc component (`DataTable`, §27) that step R5 builds, on the terms of §24a. Step R3 showed it under the content-security policy of §29.4: the showcase of the primitives draws a table that sorts from the keyboard, tells its order in `aria-sort` and counts the rows that are chosen (`apps/ops-web/test/browser/primitives.spec.ts`), under the strict policy with no violation (`primitives-policy.spec.ts`). Hand-built grid behavior stays out, as above.

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

- **One door.** `apps/ops-web/src/components/ui/icon/icons.ts` is the only file that imports the library, apart from the shadcn/ui
  primitives, whose generated source draws its own few icons (§29.2); a test and a lint rule say so. It names every icon by its **meaning** (`warning`, `success`, `sign-out`, `show-password`), never by the library's
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

**Current policy (Product Owner, 5 November 2026; built in redesign steps R3 and R5).** Some behaviour has no native element that does it the same way in every browser: a calendar, a menu, a searchable list. For that, and for nothing a native element can do, a component of the Ops Portal is composed from the **shadcn/ui primitives** (Radix UI under Tailwind CSS and the portal's tokens), through a door of its own ([§29.2](#292-the-component-foundation)). They give **behaviour** (keys, focus, names for assistive technology, positioning) and no appearance: the look is the portal's alone. React Aria Components, which the date field was built on from 28 October 2026, was **removed on 6 November 2026** (redesign step R5), when the date field moved to the calendar and popover primitives: nothing imports it, and it is not a dependency.

**Decided (Product Owner, 28 October 2026), and why no UI framework is adopted.** A library for behaviour was chosen after the same screen was built with React Aria Components, Ant Design 6 and Mantine 9 and run under the portal's content-security policy (no inline style). The other two bring a look and a token system of their own, which BRAND_FOUNDATION §14 does not let a library impose; under that policy Ant Design drew nothing of its theme (it needs a nonce on every response of a static front, and three violations remained even then) and Mantine lost the portal's colours. Material UI was considered and not built. The two builds were scratch work and are not kept in the repository; [the plan's §7.50](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#750-the-date-field-library-and-the-review-of-stage-8-28-october-2026) records what each did.

- **Native first.** A native element is used wherever it does the job (button, input, select, `<dialog>`, table). A primitive is for what none can do, and a component is built when a screen needs it (COMPONENT_PATTERNS §37), never as a catalogue.
- **One door.** Radix UI, cmdk, vaul, sonner and react-day-picker are imported only by the primitives, and only the components of `apps/ops-web/src/components/ui/` import a primitive (§29.2; a test and a lint rule say so). A page uses a component of the portal, whose properties are the portal's own, and never a type, a date object or a styling hook of a library.
- **One look.** A component draws itself from `tokens.css` alone, as every component does (the token guard applies to it), takes the global focus ring of `base.css` on every part that takes focus, keeps every part a pointer can press at least 24px (WCAG 2.2 target size) and its sizes in rem, and has forced-colours and reduced-motion rules of its own.
- **Dates.** A date crosses into and out of a component as the text `YYYY-MM-DD`, as the API carries a calendar date. It is typed and shown day, month, year (`DD/MM/YYYY`), with the week from Monday and English month names, **fixed by the portal and not taken from the browser** (decided 28 October 2026), for the reason `formatInstant` takes no words from a locale: a screen must not change with the machine, and 03/04 must never mean two different days. "Today" is the day in Accra, whatever the zone of the machine.
- **TanStack Table and Motion (Product Owner, 5 and 6 November 2026).** **TanStack Table** is adopted (redesign step R3; §23, §29.5). **Motion** (motion.dev; animation, §9) is **adopted in redesign step R5**: an exact pin, its licences shipped with the build (§29.5). The components of `components/ui` import it through the one file `components/ui/motion/motion.ts`, and a page never does (an ESLint rule and `test/motion-door.test.ts`). It is for what a stylesheet cannot do: a layout that moves (the reordered list), something that comes and goes (the table's bar of acts, the side panel) and a number that counts (the stat tile). Its durations and easings are never written in a component: one hook reads them from the motion tokens of `tokens.css` (§9), and makes everything instant when `prefers-reduced-motion: reduce` is set. What a stylesheet can do on the same tokens (the tab underline, a changed row's highlight, a hover) is left to the stylesheet, where the reduced-motion rule is the token file's own.
- **No framework migration.** The web applications are not migrated project-wide to Ant Design, MUI or another UI framework (decided 1 November 2026): each brings a look and a token system of its own, which BRAND_FOUNDATION §14 does not let a library impose. The semantic tokens control appearance. Proposing one is a foundation change (§34) and is surfaced first ([PRODUCT_DESIGN_DIRECTION §7](PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision)). shadcn/ui is not that migration: its components are source in the repository, restyled to the tokens, and no theme of a library is adopted (§29.2).
- **Web only.** This policy is for the web applications, the Ops Portal and, when it is built, the Vendor PWA. It does not prescribe Android implementation libraries: the Rider app maps the same semantic foundations to native Android (§30).

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

### The component foundation (Product Owner, 5 November 2026; redesign step R3)

Step R3 built what the kit below is composed from. It adds no Melarc component and moves no screen:

- Tailwind CSS v4 on the tokens, with no preflight (§29.3);
- the 24 shadcn/ui primitives of `apps/ops-web/src/components/primitives/` (§29.2): alert dialog, avatar, badge, breadcrumb, button, calendar, card, checkbox, command, dialog, dropdown menu, input, label, popover, scroll area, select, separator, sheet, skeleton, sonner (the toast), table, tabs, textarea and tooltip;
- TanStack Table for the data-table pattern (§23);
- the pinned shadcn CLI and its MCP server, the official registry only (§29.2);
- the content-security policy with inline style allowed and nothing else relaxed (§29.4);
- the showcase of the primitives, in both themes (COMPONENT_PATTERNS §27);
- the all-white lockup in the banner on a dark ground (§31).

The dependencies and their licences are in §29.5.

### The planned kit (Product Owner, 5 November 2026)

The redesign replaces the list of components that were deferred until real screens demanded them with a planned kit. It is composed in `components/ui` from the shadcn/ui primitives (§29.2), to §28, and each component is recorded in `COMPONENT_PATTERNS.md` §37 as PROPOSED until it is built. Redesign step R4 built the first five below (7 November 2026) and task C1 built CountBadge, which the list further down names: those six are IMPLEMENTING and await the Product Owner's acceptance. The rest are built in redesign step R5.

- AppShell v2 (the sidebar groups with counts, and the top bar), built in step R4;
- CommandPalette and global search, built in step R4;
- NewMenu, built in step R4;
- AccountMenu, built in step R4;
- HubSwitcher, built in step R4;
- Tabs with counts;
- FilterBar with chips;
- DataTable (selection, a bulk-action bar and an inline row action);
- SidePanel and Sheet;
- RecordHeader with StageTracker;
- ActionMenu (the overflow menu);
- DescriptionList;
- Panel and Card;
- Toast;
- Tooltip;
- Popover;
- StatTile;
- CountBadge;
- EmptyState v2;
- Skeleton v2.

**Built (redesign step R5, first half, 6 November 2026; COMPONENT_PATTERNS §37 records each as BUILT):** PageHeader, ViewTabs, FilterBar, DataTable, SidePanel, RecordHeader with StageTracker, ActionMenu, DescriptionList, Panel and Card, StatTile and Toast, the date field's new anatomy (§24a), and Motion. The second half (StatusBadge, CountBadge, EmptyState and Skeleton v2, Avatar, and the Tooltip, Popover and Dialog wrappers) follows.

A component that is not in the kit is added when a real screen needs it (§28).

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
  --color-surface-page: #f3f4f7;
  --color-surface-default: #ffffff;

  --color-text-primary: #0e1525;
  --color-text-secondary: #475066;

  --color-action-primary: #0e1525;
  --color-action-primary-hover: #1c2539;

  --color-border-control: #7c859a;

  --focus-ring: #2563a6;
}

:root[data-theme='dark'] {
  --color-surface-page: #090d16;
  --color-surface-default: #10151f;
  /* … the same names with the dark values; the real file also applies them by the system setting (§31). */
}
```

This example describes token intent, not a requirement to use plain CSS.

If Tailwind, CSS Modules, vanilla CSS, or another system is selected, it must consume the same semantic design model. Tailwind CSS v4 is selected for the shadcn/ui primitives since redesign step R3 (§29.2), and §29.3 says how it consumes the model.

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

### 29.2 The component foundation

**Decided (Product Owner, 5 November 2026; built in redesign step R3).** New components of the Ops Portal are built on **shadcn/ui** (the `new-york` style, over **Radix UI**) and **Tailwind CSS v4**, on the semantic tokens of this document. This supersedes, for new components, the plan of steps R1 and R2 that put them on React Aria Components with TanStack Table; what is built on React Aria stays until it moves ([§24a](#24a-interaction-primitives)).

shadcn/ui is not a package the portal depends on. It is **source copied into the repository**, from the official shadcn registry and from no other, by the pinned CLI (`shadcn`, a development dependency) or by its MCP server: `.mcp.json` at the root of the repository runs the pinned package that is installed in `apps/ops-web`, and `components.json` names no registry of its own. Each file the tool writes is reviewed and restyled through the tokens before anything uses it ([the Ops Portal's rules](../apps/ops-web/CLAUDE.md) say how). `scripts/shadcn-wiring.test.ts` holds the tool, the server and the registry.

There are three layers, and a file imports from the layer below it and from no other:

```text
pages (src/app/)  →  components/ui  →  components/primitives  →  Radix UI, cmdk, sonner, react-day-picker
                     the Melarc         generated shadcn/ui
                     components         source, on the tokens
```

- **A page imports a Melarc component and nothing else.** It never imports a primitive, or a library under one. A primitive is imported only by a component of `components/ui`, by the development-only showcase and by another primitive.
- **One door to the libraries.** Radix UI (`radix-ui` and `@radix-ui/*`), cmdk, vaul, sonner and react-day-picker are imported only from `components/primitives/`, by import, dynamic import or require. An ESLint block of `eslint.config.mjs`, `scripts/eslint-rules.test.ts` and `apps/ops-web/test/primitives-door.test.ts` say so, and the last also fails on a library that is installed and that no primitive uses.
- **Icons.** `lucide-react` stays behind the icon registry (§24) for every file but the primitives, whose generated source draws its own few icons.
- **Class names** are joined by `cn` of `src/lib/utils.ts` (clsx and tailwind-merge). The CLI leaves an `import { cn } from "cn"`, which is another package and is wrong.
- **Proof.** `apps/ops-web/test/browser/primitives.spec.ts` scans the showcase of the primitives with axe (WCAG 2.2 A and AA) in both themes, with each overlay open, and drives every overlay from the keyboard: open it, move in it, close it with Escape, find focus where it was. `primitives-policy.spec.ts` serves it as a production build under the strict policy (§29.4).

### 29.3 How the primitives take the tokens

Tailwind consumes the model and adds no colour, size or space of its own. `apps/ops-web/src/styles/tailwind.css` defines the names the shadcn/ui components read, each **only as a reference to a token**, and Tailwind reads them through `@theme inline`, so a theme that changes a token changes everything that reads it:

| shadcn/ui name | Reads | Note |
|---|---|---|
| `background`, `foreground` | `surface.page`, `text.primary` | |
| `card`, `popover` (each with its `-foreground`) | `surface.default`, `surface.raised`; `text.primary` | the raised surface is what floats: menus, popovers, toasts |
| `primary` (and `-foreground`) | `action.primary`, `action.primaryText` | Ink |
| `secondary` (and `-foreground`) | `action.secondary`, `action.secondaryText` | |
| `muted`, `accent` (each with its `-foreground`) | `surface.subtle`; `text.muted` and `text.primary` | `accent` is the hover fill |
| `destructive` | `status.danger.foreground` | the vermilion of danger, never the crimson (§4.7) |
| `border`, `input` | `border.default`, `border.control` | `input` is the control boundary of §4.6 |
| `ring` | `focus.ring` | |
| `brand` (and `-foreground`) | `action.new`, `action.newText` | the crimson of the New button, and nothing else |
| `sidebar`, `sidebar-foreground` | `surface.inverse`, `shell.textMuted` | |
| `sidebar-primary` (and `-foreground`) | `shell.active`, `shell.activeText` | the current item is crimson |
| `sidebar-accent` (and `-foreground`) | `shell.surfaceHover`, `shell.text` | |
| `sidebar-border`, `sidebar-ring` | `shell.border`, `focus.ringInverse` | |
| `radius` | `radius.md` | Tailwind's `rounded-sm`, `-md` and `-lg` read `radius.sm`, `md` and `lg` of §7 |
| `font-sans`, `font-mono` | Inter, JetBrains Mono (§5.1) | |
| `shadow-md`, `shadow-lg` | `shadow.floating` | the one shadow (§8); there is no other |

- **No colour of Tailwind's own palette is used** (`bg-red-500`, `text-white`), none is written out in a class, and no shadow but the one. The palette is cleared from the theme (`--color-*: initial`, before the names above are mapped), so a class of it draws nothing, and the scan below finds it as the mistake it is. A class string uses the names above, or an arbitrary value that reads a token (`bg-(color:--color-status-warning-background)`, `min-h-(--control-height-md)`, `duration-(--motion-normal)`). `apps/ops-web/test/primitives-tokens.test.ts` scans the primitives and their showcase for it, and `scripts/design-tokens.test.ts` holds `tailwind.css` to the rules of every stylesheet.
- **The `dark` variant** follows the theme as the token file does (§31): by `data-theme="dark"`, or by the system's setting unless the root says `data-theme="light"`. A primitive seldom needs one, because the tokens switch themselves.
- **Preflight is not imported.** `tailwind.css` takes Tailwind's theme and utilities and nothing of its base, with `source(none)` and explicit `@source` folders (`components/` and `showcase/`, no tests), so that a word in a comment is not made into a utility. Preflight resets headings, lists, links and form controls for the whole document, and the screens that exist, with `base.css`, rely on the browser's defaults for them. A reset scoped to what carries a `data-slot`, and to what is inside it, replaces the part the primitives need. *Kept:* the border colour of the border token, the neutral button and field (no border, fill or padding, the page's font and colour), the pointer on an enabled button, an opaque placeholder, a textarea that grows downward, no markers or margins on the lists and headings a primitive renders, the link that takes its text's colour, the collapsed table. *Dropped:* the reset of every element, the media rules (images and icons stay inline), the document's font and line height, and the rules for the form controls of particular browsers.
- **Layers.** Tailwind's theme, base and utilities are CSS layers, and a rule in a layer always loses to a rule in none. `tokens.css`, `base.css` and the stylesheets of `components/ui` are in no layer, so they win over any utility: the token radius (8px) over Tailwind's own default, and the focus ring of `base.css` (an outline, which forced-colours mode keeps) over the `ring` utilities. A primitive takes the global focus ring and draws none of its own.
- **Motion.** The primitives animate with `tw-animate-css` on the motion tokens (§9): `motion.fast`, `normal` and `slow` (120, 200 and 280ms) and the enter and exit easings; what a stylesheet cannot do in the components of the kit is Motion's, reading the same tokens (§24a). Under `prefers-reduced-motion: reduce` every duration token is zero, so nothing moves, and `primitives.spec.ts` proves that every overlay still opens, and is gone after Escape, then.

### 29.4 The content-security policy

**Decided (Product Owner, 5 November 2026).** The edge sends one policy on every response of a browser surface, and the Ops Portal is held to work under it ([SECURITY_DESIGN §14.8](../architecture/SECURITY_DESIGN.md#148-browser-origin-network-and-transport) owns it, and its reason). Redesign step R3 relaxes **one directive, `style-src`, and no other**:

```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Radix UI and Sonner insert `<style>` elements into the page when they run (Sonner's stylesheet when it loads, the select's and the scroll area's with their parts), and `style-src 'self'` refuses them. **`script-src` is `'self'` and is never relaxed**: it protects against injected code acting as the officer, and inline style alone cannot run code. An attacker would first need a way to put markup into the page, an HTML-injection bug, and React escapes what it renders; a style that reaches out is stopped by the directives that did not move. If a primitive needs anything else the policy refuses, the work stops and the need is reported: no other directive is relaxed for a library.

The policy is in `e2e/harness/https-front.ts` and `apps/ops-web/test/browser/support/strict-policy.ts`, which a test holds equal. `apps/ops-web/test/browser/shell.spec.ts` proves that an inline script, `eval`, `new Function` and a script from another origin are still refused, and `primitives-policy.spec.ts` that the primitives raise no violation. The static page and the shipped stylesheets stay free of inline style and of `@import` (`test/build.test.ts`): only what the libraries insert is allowed.

### 29.5 Dependencies and licences

Redesign steps R3 and R5 added these, each an exact pin as the dependency policy requires:

| Package | Version | Licence | What it is for |
|---|---:|---|---|
| `radix-ui` | 1.8.1 | MIT | Radix UI, the unified package under the primitives |
| `cmdk` | 1.1.1 | MIT | the command palette |
| `sonner` | 2.0.8 | MIT | the toaster |
| `react-day-picker` | 10.0.2 | MIT | the calendar |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | the variants of a primitive |
| `clsx` | 2.1.1 | MIT | class names |
| `tailwind-merge` | 3.7.0 | MIT | class names |
| `@tanstack/react-table` | 8.21.3 | MIT | the data-table pattern (§23) |
| `tw-animate-css` | 1.4.0 | MIT | the animations |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.3 | MIT | the stylesheet, at build time |
| `shadcn` | 4.22.1 | MIT | the CLI and its MCP server (a development dependency) |
| `motion` | 14.4.0 | MIT | animation of what a stylesheet cannot do (§24a), added by redesign step R5; it brings `framer-motion` (MIT, Framer B.V.), `motion-dom` and `motion-utils` (MIT, Motion B.V.) |

Motion's four packages ship their licences too: two texts, `Motion-MIT.txt` (Motion B.V., for `motion`, `motion-dom` and `motion-utils`) and `Framer-Motion-MIT.txt` (Framer B.V., for `framer-motion`), copied byte for byte; `apps/ops-web/test/motion-licences.test.ts` holds the list to the lockfile and to each package's own text, and `test/build.test.ts` holds what the build ships. `react-aria-components` and `@internationalized/date`, which the date field was built on, left with it on 6 November 2026 (§24a), and their three licence files with them.

Each ships with the build under its own licence (MIT asks that the notice travel with the work, Apache-2.0 that a copy of the licence does): 16 files were added to `apps/ops-web/public/licenses/`, copied byte for byte, and packages whose text is identical share one (the 61 packages of Radix UI are one file). The list is `apps/ops-web/test/support/third-party-licences.ts`; `apps/ops-web/test/shadcn-licences.test.ts` holds it to the lockfile and to each package's own text, and `test/build.test.ts` holds what the build ships to the same. The licence of the registry's own source, which the primitives are, is the `shadcn` package's. Two packages have no licence file to ship, and are named in the list with the reason: `react-remove-scroll-bar` (MIT by its `package.json`, which holds none) and `tslib` (0BSD, which asks for no notice); the type-only packages put no code in the bundle. `date-fns`, which step R3 added as a direct dependency of the portal for the calendar, was removed from it in redesign step R4: the portal imports it nowhere, and `react-day-picker` depends on it, so it is installed and its licence is shipped all the same (the list names it as a package of the tree, and it is no longer a root of it).

### 29.6 Deviations from the registry source

Each is made in the file and says so there.

- **sonner** reads the theme from `useResolvedTheme` (`src/platform/theme/`), not from `next-themes`, which the portal does not have and which would be a second owner of the theme; and it re-exports `toast`, so that the door above stays shut to every file but the primitives.
- **command**: the hidden title and description are inside the panel, where the dialog names itself from them (the registry's leave a heading in the page while it is closed). `CommandDialog` forwards `onCloseAutoFocus`, because a palette opened by a button has no `DialogTrigger` to give focus back to. Its separator is `aria-hidden`, because a list box holds only options and groups (axe `aria-required-children`).
- **calendar** is in English as written in the United Kingdom and starts its week on Monday by default, as the date field does (COMPONENT_PATTERNS §22a), not in the browser's language.
- **popover** gains a `container` prop (the element the popover is drawn into, the body by default): a modal `<dialog>` is in the top layer and the page behind it is inert, so the date field's calendar, opened from inside one, is drawn into the dialog or it would open under it, unseen and out of reach.
- **scroll-area**: the viewport is a stop of the keyboard, so that what scrolls can be reached without a pointer (WCAG 2.1.1; axe `scrollable-region-focusable`).
- **button** has no `xs` sizes (they would be 24px targets, below the smallest control height) and gains the `brand` variant: the crimson of the New button, and nothing else. `destructive` is the outline Danger recipe of §4.6, since no filled Danger button is part of the system (§16.3).
- **badge** gains the five status variants, `success`, `warning`, `danger`, `info` and `neutral`, from the pairs of §4.4.
- **tabs** are an underline, not a pill.

### 29.7 What the Product Owner should know

- **The Radix menu and select are modal.** While one is open the page behind it is hidden from assistive technology and focus is held inside. axe takes only a dialog for a modal, so it reports the controls behind as hidden but focusable (`aria-hidden-focus`); that one rule is switched off for those two open states, and only there, in `primitives.spec.ts`, with the reason written beside it. Everything else is scanned with every rule, in both themes.
- **Tab does nothing inside an open Radix menu or list** (Radix prevents it: a menu is not walked with Tab). Escape closes it and gives focus back to its button.
- **A palette opened by a button does not get focus back by itself.** Radix returns focus to a `DialogTrigger`, and a command palette has none, so focus would land on the page. The primitive forwards `onCloseAutoFocus` for it; the Melarc palette of step R5 must use it, and the showcase does.

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

Light and dark themes are **both in Version 1** (Product Owner, 5 November 2026). Dark mode is no longer deferred.

A theme is a second set of values for the same semantic names, never a second set of components. Components consume semantic tokens only, so:

```text
color.surface.default
```

is white in one theme and a dark surface in the other, and no component names a raw value such as:

```text
#FFFFFF
```

The only exceptions are the two fixed colors of §4.2, `white` and `black`, which a QR code and the tile behind the symbol need to be the same in both themes.

**Implemented as tokens (redesign step R2).** Both themes are in the token file, and the values are §4.3 and §4.4:

- the light values are the `:root` block, and are in force unless something below applies;
- the dark values are applied by the operating system's setting unless the root carries `data-theme="light"` (`@media (prefers-color-scheme: dark)` on `:root:not([data-theme='light'])`), and by `data-theme="dark"`, whatever the system says. So a later toggle wins both ways, and the dark values are written in both places and a test fails if the two differ;
- `color-scheme` follows the theme, so that native controls (scrollbars, checkboxes, form fields) do too;
- each dark pairing is in §4.6 and is held by the tests as the light pairings are, and the components are scanned in the dark in a real browser (§14).

**The choice of theme.** The portal follows the operating system's light or dark setting by default. A person may override it, and that choice is kept in the browser's local storage: a non-sensitive preference, approved as a browser-storage decision under [PRODUCT_DESIGN_DIRECTION §7](PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision) (Product Owner, 5 November 2026). **As built in redesign step R4:** the theme control of the top bar and the account menu offer *System* (the default), *Light* and *Dark*; the choice is kept under one key, `melarc-theme`, written for Light and Dark and removed for System, in one module (`apps/ops-web/src/platform/theme/theme-choice.ts`, the only exception to the rule that application code uses no web storage, named in the ESLint configuration) that sets `data-theme` on the root, and the token file still reads no storage. A script of the page's own origin (`public/theme-init.js`, a classic script in the head of `index.html`) applies the stored choice before the first paint, because a module script is deferred and an inline one is refused by the content-security policy; a value that is not `light` or `dark` is ignored, and the other tabs of the browser follow a change.

The logo has its own version for dark grounds ([BRAND_FOUNDATION §4.7](BRAND_FOUNDATION.md#47-the-logo-in-the-ops-portal)). Since redesign step R3 the banner of the Ops Portal's frame (the sign-in screens and the neutral pages) draws the all-white lockup whenever the dark theme applies, by the system's setting or by `data-theme="dark"`: `AppFrame` chooses the file with `useResolvedTheme`, one image that carries the name once, and `src/app/frame-logo.test.tsx` holds it. The Ink sidebar draws the all-white lockup in both themes (redesign step R4).

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

- ~~Tailwind CSS~~ (decided on 5 November 2026: Tailwind CSS v4 on the semantic tokens, with no preflight, §29.3);
- ~~Radix UI~~ and ~~shadcn/ui~~ (decided on 5 November 2026: shadcn/ui over Radix UI is the component foundation of new components, §29.2);
- Material UI;
- Ant Design;
- Storybook;
- another component workshop;
- CSS Modules;
- CSS-in-JS;
- ~~a library for behaviour a native element lacks~~ (decided on 28 October 2026: React Aria Components, §24a; Ant Design and Mantine were
  built and run for it and Material UI was considered, and React Aria Components was chosen over them; superseded on 5 November 2026 by the shadcn/ui
  primitives, §29.2, and React Aria Components was removed on 6 November 2026);
- ~~a specific icon library~~ (decided on 25 October 2026: Lucide, §24).

Those should be selected based on the actual web implementation and project constraints.

The selected technology must serve this design system, not redefine it.

Since 1 November 2026 a project-wide move to Ant Design, MUI or another UI framework is outside the approved direction. Since 5 November 2026
the component foundation of new components is shadcn/ui over Radix UI and Tailwind CSS (§29.2), TanStack Table is adopted (§23), Motion is adopted
(§24a, since 6 November 2026), and a specialist grid is weighed against a concrete screen before advanced grid behavior is built by hand (§24a, §23).

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
| Primitive palette values | **REPLACED** (5 November 2026): colour has two primitives, `white` and `black` (§4.2); every other colour is a semantic token with a light and a dark value (§4.3, §4.4) |
| Interface crimson `#B4232E` | **REPLACED** (Product Owner, 5 November 2026) by the logo red `#BE1E2D` for the brand (`#F04B59` in the dark theme), with the primary action moved to Ink (§4.7); in force since step R2. The logo's own red stays a reference until the owner confirms the vector master (§4.1) |
| Interface ink `#172033` | **REPLACED** by `#0E1525` (5 November 2026, §4.3); in force since step R2 |
| Inter | **APPROVED** (6 October 2026), self-hosted as the variable Latin and Latin Extended files of §5.1 under the SIL Open Font License 1.1; **JetBrains Mono** is approved for operational codes only (5 November 2026) and shipped since step R2, as its variable Latin file at weights 500 and 600 (§5.1) |
| 4px spacing base | **APPROVED** (6 October 2026) |
| Responsive breakpoint set | **APPROVED** (6 October 2026) |
| Blue focus ring `#2563A6` | **APPROVED** (6 October 2026) for the light theme; `#7AA7F0` in the dark theme (5 November 2026) |
| Light and dark themes (§31, §4.3) | **APPROVED for Version 1** (Product Owner, 5 November 2026); built as tokens in step R2, where the system's setting decides; the toggle and its stored choice were built in step R4 (7 November 2026, §31) |
| Theme choice (§31) | **DECIDED** 5 November 2026 (Product Owner): follows the operating system by default; a person may override it; the choice is kept in the browser's local storage as a non-sensitive preference ([PRODUCT_DESIGN_DIRECTION §7](PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision)); the toggle was built in step R4 (7 November 2026, §31) |
| Visual direction (§4.7) | **APPROVED** 5 November 2026: Ink carries the work and crimson carries the brand; the palette, the radii (8, 12 and 16px), the heights (36, 44 and 56px), the motion and the one shadow are the values in force since step R2; the values R2 derived (§4.3), the 44px controls, the 36px rows and the single floating shadow were approved as built on 5 November 2026, in the task of step R3 |
| Devices (§12) | **DECIDED** 5 November 2026: hub-floor tasks are tablet-first at 768px; the record panel is a full-screen sheet and the sidebar collapses to icons at that width |
| Planned component kit (§27; COMPONENT_PATTERNS §37) | **APPROVED** 5 November 2026 and **PROPOSED** as patterns, except the six built (the shell's five in step R4, 7 November 2026, and CountBadge in task C1: **IMPLEMENTING**, awaiting the Product Owner's acceptance); the rest is built in step R5 |
| Tailwind (§29.2, §29.3) | **DECIDED** 5 November 2026 (Product Owner): Tailwind CSS v4 on the semantic tokens, preflight not imported; built in step R3 |
| Radix, shadcn/ui (§29.2) | **DECIDED** 5 November 2026 (Product Owner): shadcn/ui over Radix UI is the component foundation of new components, from the official registry only, through `components/primitives` and one door; built in step R3, which awaits the Product Owner's acceptance |
| Content-security policy (§29.4) | **DECIDED** 5 November 2026 (Product Owner): `style-src 'self' 'unsafe-inline'`, and no other directive relaxed; `script-src` is never relaxed |
| Shared web component package | **NOT YET REQUIRED** |
| Shared brand asset package | **POSSIBLE LATER** |
| Supported pairings and state recipes (§4.6) | **APPROVED** (6 October 2026), including the danger outline recipe; written again for the two themes and the new palette in step R2, where the values it derived are marked in §4.3 |
| Inverse focus, inverse link and Ink-shell indicator values (§4.6) | **APPROVED** as proposed (Product Owner, 6 October 2026); first used by the authenticated Ops shell |
| `border.control` | **DECIDED** 6 October 2026 (darkened so one token is the boundary of an input wherever it sits); **`#7C859A`** in the light theme and **`#667085`** in the dark since 5 November 2026, 3:1 on the surfaces §4.6 lists |
| WCAG 2.2 AA design baseline (§14) | **DECIDED** 6 October 2026: components are tested to 2.2 AA, and `surfaces/ops-portal.md` §11 and `vendor-pwa.md` §9 now say 2.2 AA is the working target; the formal conformance level stays **OPEN** (master §40.6) |
| Setup routes: neutral frame or a bare layout (§13.1) | **DECIDED** 6 October 2026: the neutral frame |
| First implementation scope (COMPONENT_PATTERNS §42.2) | **CONFIRMED** 6 October 2026, built in three increments |
| Browser coverage of the component acceptance (§14) | **DECIDED** 6 October 2026: Chromium, Firefox and WebKit in CI; Chromium locally unless the others are installed |
| Source of the signed-in navigation entries (§22) | **DECIDED** 6 October 2026: the `permissions` list of the `Session` resource |
| The authenticated shell's navigation: a top band or a side menu (§13.1, §22) | **DECIDED** 25 October 2026 (Product Owner, with a reference screenshot): a collapsible **side menu** on Ink with an account card; the Ops Portal is an application, not a website |
| Layout of the pre-sign-in screens (§13.1, §13.1a) | **DECIDED** 25 October 2026 (Product Owner): a **split screen**, photography beside the form; the photographs are theirs (`design/images`), their licence is theirs to confirm |
| Icon family (§24) | **DECIDED** 25 October 2026 (Product Owner): **Lucide**, through one registry; IconButton is built |
| Interaction primitives (§24a) | **DECIDED** 28 October 2026 (Product Owner): **React Aria Components** for behaviour only, through the components of `components/ui`; the date field was its first component. **Superseded for new components** on 5 November 2026 by the shadcn/ui primitives (§29.2), and **removed** on 6 November 2026, when the date field moved to the calendar and popover primitives (COMPONENT_PATTERNS §37) |
| Web library policy (§23, §24a) | **DECIDED** 1 November 2026 (Product Owner): native elements first; the semantic tokens control appearance; **no project-wide migration** to Ant Design, MUI or another UI framework; a **specialist grid is weighed against a concrete screen's requirements** before advanced grid behavior is built by hand; a web policy that does not prescribe Android libraries. On 5 November 2026 **TanStack Table** was adopted, in redesign step R3; **Motion** is adopted in redesign step R5 (6 November 2026; §24a, §29.5); new components are composed from the shadcn/ui primitives (§29.2) |
| Date entry and display (§24a; COMPONENT_PATTERNS §22a) | **DECIDED** 28 October 2026 (Product Owner): day, month, year, week from Monday, English; fixed by the portal and not the browser's; "today" is Accra's |
| Brand asset layout (§26 owns it) | **DECIDED in this revision** (document structure; no brand approval implied) |
| Self-hosted typeface files | **DONE** for Inter and JetBrains Mono (§5.1) |

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
