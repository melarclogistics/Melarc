# Melarc Brand Foundation

> **Status:** ACTIVE FOUNDATION — approved brand direction; exact interface token values and production logo assets remain subject to the confirmations identified in this document  
> **Version:** 1.1  
> **Date:** 5 October 2026; revised 6 October 2026 (§11.1 permission wording, §19 asset layout) after the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md); no approved decision changed then. Revised 5 November 2026 for the Product Owner's decisions of that date (§2, §4.7, §5.2, §5.4, §5.5, §6.4, §17, §19, §21, §22), and again that day with redesign step R2, which made the values in force (§2.1, §2.2, §4.7, §5.2 to §5.4, §11.1, §22)  
> **Repository path:** `design/BRAND_FOUNDATION.md`  
> **Owns:** Melarc brand personality, logo usage principles, brand color direction, typography direction, visual character, imagery/iconography direction, voice, and cross-platform brand consistency  
> **Does not own:** detailed component specifications, framework/library selection, screen layouts, product workflow rules, API behavior, or domain-state semantics

---

## 1. Purpose

This document defines the visual and verbal foundation for Melarc product interfaces and supporting brand applications.

It exists to ensure that the Ops Portal, Vendor PWA, Rider Android application, public-facing digital touchpoints, and future design work present one coherent Melarc identity without forcing identical layouts or interaction patterns across platforms.

The Brand Foundation is intentionally technology-neutral. It may be implemented with any appropriate frontend or native UI stack as long as the resulting experience conforms to the principles and approved decisions in this document.

Detailed semantic tokens, accessibility pairings, responsive behavior, density rules, and component states belong in `design/DESIGN_SYSTEM.md`.

Implemented component patterns belong in `design/COMPONENT_PATTERNS.md`.

The experience direction (how screens are composed, which references inform them, and when a proposal needs a product decision) belongs in [PRODUCT_DESIGN_DIRECTION.md](PRODUCT_DESIGN_DIRECTION.md).

---

## 2. Decision status

### 2.1 Approved

The following choices are approved product/design direction:

- **Brand character:** professional, trustworthy, modern, and premium.
- **Visual direction:** **Crimson + Ink**.
- **Product density:** balanced:
  - spacious application shell, navigation, and page composition;
  - efficient forms, operational tables, and task-focused data views.
- **Brand/logo principle:** preserve the existing Melarc logo identity rather than redesigning it for the application.
- **Cross-platform principle:** share brand identity and semantic foundations while allowing platform-appropriate interaction density and native behavior.
- **Color roles (Product Owner, 5 November 2026):** Ink carries the work, crimson carries the brand. The primary action is Ink; crimson is for the brand mark, the "New" button and the active sidebar item; danger is a separate vermilion; links are Ink. This replaced crimson as the primary-action color (§5.4, §5.5). The values are [DESIGN_SYSTEM §4.3 and §4.4](DESIGN_SYSTEM.md#43-core-semantic-color-tokens), in force since redesign step R2, and the roles are [§4.7](DESIGN_SYSTEM.md#47-colour-roles).
- **Themes (Product Owner, 5 November 2026):** a light and a dark theme are both in Version 1. Both are implemented as tokens (step R2); the portal follows the system's setting, and the toggle arrives in step R4 ([DESIGN_SYSTEM §31](DESIGN_SYSTEM.md#31-dark-mode)).
- **The logo on dark grounds and in the Ops Portal (Product Owner, 5 November 2026):** §4.7.

### 2.2 Provisional implementation values

The following values are working design inputs, not immutable brand law:

- interface crimson `#BE1E2D` and interface ink `#0E1525` (5 November 2026; they replaced `#B4232E` and `#172033`);
- supporting neutral and semantic palette values in §5;
- Inter as the recommended product-interface typeface;
- exact spacing, radius, elevation, motion, and responsive values.

These values may be refined in the Design System when accessibility and real component usage are verified.

**Settled since.** The Product Owner approved Inter as the active typeface on 6 October 2026 ([DESIGN_SYSTEM §36](DESIGN_SYSTEM.md#36-current-design-system-decision-summary)). Read the RECOMMENDED label of this section and of §22, and the open typeface item of §2.3, accordingly for it.

**Changed since.** The decisions of 5 November 2026 replaced the interface crimson `#B4232E` and the interface ink `#172033` with the logo red `#BE1E2D` and `#0E1525`, and took the primary action from crimson (§5.5). They have been the values in force since redesign step R2 ([DESIGN_SYSTEM §4.3](DESIGN_SYSTEM.md#43-core-semantic-color-tokens)). Inter stays, with a monospaced face for operational codes, JetBrains Mono (§6.4).

### 2.3 Open asset/design confirmations

The following remain open:

- original vector logo artwork, preferably SVG;
- authoritative source color values from the vector artwork;
- approved symbol-only logo variant for any use beyond the Ops Portal's browser-tab icon (approved for that alone on 25 October 2026; its provisional use as the mark of the side menu and the split screen waits for confirmation);
- official minimum logo size based on vector artwork;
- exact logo clear-space rule based on the source geometry;
- final product UI typeface approval.

No implementation task may silently invent these assets or present an approximation as official artwork.

---

## 3. Brand idea

### 3.1 Core character

Melarc should feel:

- **Reliable** — operational information is clear, stable, and trustworthy.
- **Professional** — visual choices are deliberate rather than decorative.
- **Modern** — interfaces are current, efficient, responsive, and technically polished.
- **Premium** — restraint, spacing, typography, and detail communicate quality without appearing luxurious or ornamental.
- **Operationally competent** — the product feels designed for real logistics work, not like a marketing dashboard.

### 3.2 Desired impression

A user should reasonably describe Melarc as:

> "A serious modern logistics company with a disciplined, dependable system."

The product should not feel:

- playful or cartoonish;
- visually noisy;
- aggressively futuristic;
- overly corporate or bureaucratic;
- generic SaaS;
- visually dominated by red;
- styled like a consumer social application;
- like a copied third-party component library.

---

## 4. Logo foundation

### 4.1 Current supplied logo

The supplied reference image is **355 × 145 px** with a white background.

The dominant solid logo colors sampled from that PNG are:

| Role | Sampled value | Status |
|---|---:|---|
| Logo red | `#BE1E2D` | **Provisional — sampled from PNG** |
| Logo black | `#000000` | **Provisional — sampled from PNG** |
| Background | `#FFFFFF` | Reference image background |

If original vector artwork defines different values, the vector artwork takes precedence.

### 4.2 Logo composition

The current identity consists of:

- a geometric red/black symbol;
- the black **Melarc** wordmark;
- the red **LOGISTICS** descriptor.

This composition should remain intact unless an approved alternate lockup is supplied.

### 4.3 Production asset rule

The supplied PNG is suitable as a visual reference but should not be treated as the preferred production master.

Preferred source hierarchy:

1. approved SVG/vector master;
2. approved high-resolution transparent raster export;
3. supplied PNG reference only when no better asset is available.

Do not redraw the logo from observation.

Do not trace or approximate the wordmark.

Do not automatically recolor the logo to match interface tokens.

### 4.4 Required logo variants

Before production release, obtain or explicitly approve:

- **Primary horizontal logo** — symbol + Melarc + LOGISTICS;
- **Symbol-only mark** — for favicon/app-icon/small placements where approved;
- **Dark-background treatment** — explicitly designed, not auto-inverted;
- **Monochrome treatment** — only if required for documents, embossing, print, or constrained channels.

Until those variants exist, use the supplied primary logo only where its original treatment remains legible.

### 4.5 Logo clear space

Until vector geometry is available, use a conservative temporary clear-space rule:

> Keep free space around the complete logo equal to at least the height of the red square element within the symbol.

This is provisional and should be replaced by an exact vector-based construction rule.

### 4.6 Logo misuse

Do not:

- stretch or compress the logo;
- rotate it;
- add shadows, glows, gradients, outlines, or bevels;
- change the relationship between the symbol, wordmark, and descriptor;
- recolor individual logo elements for interface states;
- place it over visually noisy imagery;
- use it as a decorative watermark throughout the application;
- crop the wordmark to create an unofficial symbol-only version;
- use interface `danger` color semantics as a reason to recolor the logo;
- recreate the wordmark using a substitute font.

### 4.7 The logo in the Ops Portal

**Product Owner, 5 November 2026.** The portal uses the horizontal Melarc Logistics lockup (the symbol, the wordmark and the descriptor of §4.2; the primary horizontal logo of §4.4) in two versions, chosen by the ground it stands on:

- **On the Ink sidebar and on any dark ground:** the all-white version, `design/assets/Transparent White  Logo.svg` (two spaces in the supplied name), filed as `exports/melarc-logo-dark.svg`.
- **On light grounds:** the full-color version, `design/assets/Transparent Logo.svg`, filed as `master/melarc-logo-primary.svg`.

The vector masters already exist; [the brand README](assets/brand/README.md) records where each came from. The artwork is used as supplied and never redrawn, recolored or traced (§4.3, §4.6). Since redesign step R3 the banner of the portal's frame (the sign-in screens and the neutral pages) draws the all-white version whenever the dark theme applies, and the full-color version otherwise. The Ink sidebar draws the lockup from redesign step R4: until then the side menu is as built, with the symbol as its mark (§22).

---

## 5. Color foundation

## 5.1 Brand versus interface color

The **logo palette** and **interface palette** are related but distinct.

The logo should preserve its official source artwork.

The interface uses a darker crimson and ink foundation to improve product usability, depth, and accessibility.

This separation is intentional.

### 5.2 Working interface palette

The Design System owns the values ([DESIGN_SYSTEM §4.3 and §4.4](DESIGN_SYSTEM.md#43-core-semantic-color-tokens), a light and a dark value for each token); this table is the brand's view of them, by role.

| Role | Light | Dark | Status | Intended use |
|---|---:|---:|---|---|
| Brand crimson | `#BE1E2D` | `#F04B59` | Replaces `#B4232E` (5 November 2026); the light value is the logo red | The brand mark, the "New" button, the active sidebar item, the small crimson square |
| Ink | `#0E1525` | `#EDF0F6` (as text and as the primary action) | Replaces `#172033` (5 November 2026) | Primary text, the primary action, the sidebar |
| Canvas | `#F3F4F7` | `#090D16` | In force since step R2 | Main application background |
| Surface | `#FFFFFF` | `#10151F` | In force since step R2 | Cards, panels, tables, forms |
| Tertiary text | `#626B81` | `#8E98AC` | In force since step R2 | Supporting copy |
| Subtle border | `#E2E5EB` | `#222A38` | In force since step R2 | Decorative/divider borders |
| Success | `#0B6B44` | `#5CCB95` | In force since step R2 | Positive state ("Done") |
| Warning | `#8A4F00` | `#F0B45A` | In force since step R2, with its accessible pairing | Warning semantics ("Waiting") |
| Danger | `#A8320E` | `#FF8A66` | In force since step R2; a vermilion, never crimson | Destructive/error semantics |
| Info | `#1F4E96` | `#86B1F4` | In force since step R2 | Informational semantics ("In progress") |

### 5.3 Accessibility observations

Measured contrast against white for key colors of the light theme (the dark theme's pairings are in [DESIGN_SYSTEM §4.6](DESIGN_SYSTEM.md#46-supported-pairings-and-state-recipes)):

| Color | Contrast vs white | Interpretation |
|---|---:|---|
| `#BE1E2D` | 6.15:1 | Suitable for normal white text |
| `#0E1525` | 18.22:1 | Strong primary-text contrast |
| `#626B81` | 5.33:1 | Suitable for normal text on white |
| `#0B6B44` | 6.56:1 | Suitable for status text |
| `#8A4F00` | 6.56:1 | Suitable for status text; its own soft background gives 5.99:1 |
| `#A8320E` | 6.71:1 | Suitable for danger text and white-text treatment |
| `#2563A6` | 6.15:1 | Suitable for the focus ring |
| `#7C859A` | 3.70:1 | Meets the 3:1 a control boundary needs |
| `#C9CED8` | 1.58:1 | **Too subtle to be the sole required boundary of an input/control** |
| `#E2E5EB` | 1.26:1 | **Too subtle to be the sole required boundary of an input/control** |

The Design System defines, for each theme:

- a stronger interactive-control boundary than the structural borders where visual boundaries are required (`color.border.control`);
- verified warning foreground/background pairs;
- focus-ring colors and thickness;
- selected, hover, pressed and disabled states (visited has no color until a screen needs one);
- accessible text/background pairs for badges and alerts.

### 5.4 Brand crimson versus danger

`brand crimson` and `status.danger` are **separate semantic concepts**. **Resolved (Product Owner, 5 November 2026): danger is a separate vermilion and never crimson, and a danger act is always placed last** (the last item of its menu or group). Since redesign step R2 they are separate tokens with separate values: danger is the vermilion `#A8320E` (`#FF8A66` in the dark theme) and the brand crimson is `#BE1E2D` (`#F04B59`) ([DESIGN_SYSTEM §4.3 and §4.4](DESIGN_SYSTEM.md#43-core-semantic-color-tokens)).

Do not implement components against a raw red value.

Use semantic tokens so either value may change independently later.

Danger must never rely on red alone. Destructive actions and error states must also use appropriate:

- wording;
- iconography where useful;
- confirmation behavior;
- placement/hierarchy;
- accessible state labels.

### 5.5 Color usage principle

Melarc should not become a "red interface."

**Ink carries the work, crimson carries the brand** (Product Owner, 5 November 2026). Use crimson deliberately, and only for:

- the brand mark;
- the "New" button;
- the active sidebar item, a solid crimson fill with white bold text;
- the small crimson square, taken from the logo, that marks the active hub and the current step.

The primary action is Ink, one per view; in the dark theme it is near-white with Ink text. Links are Ink, not crimson. Danger is a separate vermilion (§5.4). Use ink, white, and restrained neutrals, tinted toward Ink, for the structural surfaces.

Recommended visual balance:

- **Ink:** authority, navigation and the primary action;
- **White/neutral:** working area;
- **Crimson:** the brand;
- **semantic colors:** operational state meaning.

---

## 6. Typography foundation

### 6.1 Direction

The interface typography should feel:

- highly legible;
- neutral-professional;
- modern;
- strong with numbers, tables, and dense operational data;
- calm under repeated daily use.

### 6.2 Recommended product typeface

**Inter** is the recommended initial interface typeface.

Status: **recommended, not yet formally approved as a permanent brand typeface**. The Product Owner adopted Inter for the Ops Portal interface on 6 October 2026 ([DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §5.1); whether it is the permanent brand typeface is not decided.

Reasons:

- strong screen readability;
- clear numeric forms;
- effective at compact UI sizes;
- broad weight support;
- appropriate for operational dashboards;
- neutral enough that Melarc identity remains driven by the wider system.

If another typeface is proposed, compare it against Inter using real Melarc tables, forms, numeric values, status labels, and mobile layouts before approval.

### 6.3 Working type hierarchy

Exact token names and values belong in the Design System, but the intended hierarchy is:

| Role | Working size range | Weight direction |
|---|---:|---|
| Page title | 28–32 px | Semibold |
| Section title | 20–24 px | Semibold |
| Card/panel title | 16–18 px | Semibold |
| Body | 14–16 px | Regular |
| Operational table | 13–14 px | Regular/medium as needed |
| Field label | 12–14 px | Medium |
| Caption/meta | 12 px | Regular/medium |

Do not use many unrelated font sizes.

Do not use decorative typefaces inside operational product interfaces.

### 6.4 Numeric/data typography

Operational numeric values should:

- align predictably in tables;
- avoid unnecessarily stylized numerals;
- remain distinguishable at dense sizes;
- use tabular numerals everywhere numbers are read (Product Owner, 5 November 2026).

Operational codes (such as `HUB-TT-XXXXXX`) are set in a monospaced face, so that a code read aloud never blurs ([DESIGN_SYSTEM §5.1](DESIGN_SYSTEM.md#51-typeface)).

---

## 7. Spacing and density character

Melarc uses a **balanced density model**.

### 7.1 Spacious zones

Use more breathing room for:

- application shell;
- navigation;
- page headers;
- dashboard composition;
- major sections;
- onboarding/explanatory content.

### 7.2 Efficient zones

Use compact but accessible treatment for:

- operational tables;
- filter bars;
- repeated data rows;
- form-heavy workflows;
- detail drawers/panels;
- task queues;
- status-heavy views.

### 7.3 Density rule

> Density follows the task, not the page globally.

Do not make every component spacious merely because the shell is spacious.

Do not compress the entire application into a control-room grid merely because some operational tables are dense.

Touch interfaces must preserve appropriate hit areas even when information density is high.

---

## 8. Shape, depth, and visual restraint

Melarc should use restrained geometry.

Direction:

- modest corner radii;
- clear rectangular structure;
- limited decorative rounding;
- subtle elevation;
- borders and background contrast before heavy shadows;
- strong alignment and spacing.

Avoid:

- excessive pill shapes;
- oversized floating cards everywhere;
- glassmorphism;
- neon effects;
- heavy gradients;
- dramatic blur;
- deep decorative shadows;
- ornamental motion.

Premium quality should come from discipline, hierarchy, spacing, and interaction detail rather than visual effects.

---

## 9. Iconography

Icons should be:

- simple;
- geometric;
- consistent in stroke/fill style;
- immediately legible;
- secondary to text in critical workflows.

Icons must not be the sole carrier of meaning for important operational actions unless the convention is universally clear and the control has an accessible label.

Avoid mixing unrelated icon families.

Domain-specific icons should be introduced only when they add comprehension.

---

## 10. Imagery and photography

Operational applications should use imagery sparingly.

When brand photography is used outside task interfaces, prefer:

- authentic logistics environments;
- real parcels, riders, hubs, vendors, and operational context;
- clean composition;
- natural but controlled lighting;
- credible Ghanaian/West African context where relevant;
- professional realism rather than generic stock imagery.

Avoid:

- staged handshake imagery;
- generic corporate teams unrelated to logistics;
- excessive red overlays;
- fake futuristic logistics imagery;
- decorative parcel imagery inside data-heavy operational screens.

Product UI should not depend on photography for navigation or comprehension.

---

## 11. Voice and language

Melarc product language should be:

- direct;
- calm;
- respectful;
- operational;
- precise;
- action-oriented where needed.

### 11.1 Preferred style

Prefer:

- "Assign rider"
- "Pickup request created"
- "Delivery could not be completed"
- "Try again"

These show tone, not approved copy. Permission and approval wording belongs to the feature that owns the rule. A refusal
names the capability in plain words ("An approver decides this") and never a raw permission key or a role; the key may
appear only in a tooltip or a technical detail for support. The rule is
[PRODUCT_DESIGN_DIRECTION §6.5](PRODUCT_DESIGN_DIRECTION.md#65-on-screen-language), and
[surfaces/ops-portal.md](../surfaces/ops-portal.md) §7 applies it row by row.

Avoid:

- "Oops!"
- "Awesome!"
- "Something magical happened"
- vague failure messages;
- blame-oriented language;
- excessive exclamation marks;
- marketing copy in operational workflows.

### 11.2 Error language

Errors should answer, where possible:

1. What happened?
2. What can the user do next?
3. Is data already saved or not?
4. Is another person/permission/state required?

Never expose internal exceptions, stack traces, database terms, or security-sensitive implementation details to end users.

---

## 12. Accessibility foundation

Accessibility is part of the brand quality standard, not a later compliance pass.

Melarc interfaces must be designed so that:

- information is not encoded by color alone;
- focus is clearly visible;
- keyboard navigation works on applicable web surfaces;
- labels are explicit;
- interactive targets are usable;
- error states are associated with the relevant control;
- important contrast combinations are verified;
- loading states do not trap or confuse the user;
- motion does not carry required meaning;
- responsive layouts remain understandable when enlarged or reflowed.

The Design System owns the detailed accessibility requirements and token pairings.

---

## 13. Cross-platform brand consistency

Melarc should feel like one product family without forcing every platform into one layout.

### 13.1 Ops Portal

Character:

- desktop-first operational workspace;
- efficient keyboard workflows;
- balanced information density;
- compact tables where useful;
- strong filtering/status hierarchy;
- spacious application shell.

### 13.2 Vendor PWA

Character:

- responsive;
- straightforward;
- confidence-building;
- clear forms and tracking;
- less dense than Ops;
- strong mobile behavior.

### 13.3 Rider Android

Character:

- task-focused;
- large touch targets;
- strong outdoor readability;
- minimal cognitive overhead;
- native Android interaction conventions;
- status and action clarity over visual density.

Shared web CSS is **not** the cross-platform design system.

Share:

- brand identity;
- semantic color concepts;
- typography principles;
- status meaning;
- spacing philosophy;
- tone.

Implement them with platform-appropriate native primitives.

---

## 14. UI technology neutrality

This Brand Foundation does not mandate:

- Tailwind CSS;
- Radix UI;
- Material UI;
- Ant Design;
- shadcn/ui;
- a CSS-in-JS system;
- any specific component library.

Such technology decisions belong to implementation architecture and the Design System.

A library is acceptable only if Melarc retains ownership of:

- visual identity;
- semantic tokens;
- accessibility expectations;
- interaction semantics;
- component API conventions.

The product must not simply inherit the visual identity of a third-party library.

---

## 15. Relationship to design tokens

Implementation should use design tokens rather than hard-coded visual values.

The intended hierarchy is:

```text
Primitive token
    ↓
white
space.4
radius.md

Semantic token
    ↓
color.action.primary
color.text.primary
color.surface.page
color.border.control
color.status.success

Component token
    ↓
button.primary.background
input.border.default
sidebar.item.active
status.badge.warning
```

The exact token schema belongs in `design/DESIGN_SYSTEM.md`.

Do not couple business/domain enum names directly to raw color values.

---

## 16. Brand use in status-heavy operational UI

Operational states should use semantic status treatment, not arbitrary per-screen styling.

For example:

- successful/completed state → semantic positive treatment;
- warning/attention state → semantic warning treatment;
- failed/destructive state → semantic critical treatment;
- neutral/pending state → neutral or informational treatment as specified.

The underlying domain enum remains authoritative.

The design layer maps domain meaning to semantic visual presentation.

Do not assume that every status containing "failed" must use the exact brand crimson.

---

## 17. Initial product UI scope

The first UI foundation should remain intentionally small.

Initial foundation scope:

- color tokens;
- typography tokens;
- spacing tokens;
- radius tokens;
- focus treatment;
- button/link styling;
- input/label/help/error styling;
- alert styling;
- basic loading treatment;
- existing neutral application frame;
- page heading;
- error/not-found presentation;
- development-only component showcase.

Do not build speculative dialogs, data grids, menus, drawers, toast systems, or large component libraries before actual product requirements need them.

This is the scope of the first gate. The planned kit of the Ops Portal redesign (5 November 2026) is [DESIGN_SYSTEM §27](DESIGN_SYSTEM.md#27-initial-implementation-scope)'s.

`design/COMPONENT_PATTERNS.md` should grow with implemented components.

---

## 18. Brand quality checklist

Before accepting a Melarc UI implementation, verify:

### Logo
- [ ] Approved logo asset used.
- [ ] Logo aspect ratio preserved.
- [ ] Logo colors not silently recolored.
- [ ] Sufficient clear space.
- [ ] Background provides adequate visual separation.
- [ ] No unofficial cropped/symbol variant created.

### Color
- [ ] Semantic tokens used rather than scattered hex values.
- [ ] Crimson is not overused.
- [ ] Danger is distinguished by more than color.
- [ ] Required contrast is verified.
- [ ] Control boundaries and focus indicators remain perceivable.

### Typography
- [ ] Hierarchy is consistent.
- [ ] Dense data remains readable.
- [ ] No decorative fonts in operational workflows.
- [ ] Numeric presentation is stable.

### Layout
- [ ] Shell feels spacious.
- [ ] Operational areas use appropriate efficiency.
- [ ] Density responds to the task and platform.
- [ ] Touch targets remain usable.

### Voice
- [ ] Labels are precise.
- [ ] Errors explain recovery where possible.
- [ ] Copy is calm and professional.
- [ ] No playful filler language in operational tasks.

### Accessibility
- [ ] Keyboard/focus behavior is usable where applicable.
- [ ] Color is not the only information carrier.
- [ ] Form controls are labelled.
- [ ] Error states are connected to affected controls.
- [ ] Responsive/reflow behavior remains understandable.

---

## 19. Missing production assets

The following should be collected and added to the repository in a later dedicated asset task. Where each file goes is
owned by [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §26 (`master/` for the vector source, `exports/` for approved derived
files); this list only says what is missing:

- `melarc-logo-primary.svg`, the approved vector master (`master/`);
- `melarc-logo-primary.png`, the approved high-resolution transparent export (`exports/`);
- ~~`melarc-symbol.svg`~~, supplied and approved on 25 October 2026 for the Ops Portal's browser-tab icon alone (`exports/`); its use as the mark of the side menu and the split screen is provisional, owner to confirm;
- ~~`melarc-logo-dark.svg`~~, supplied and approved on 5 November 2026 as the logo for the Ink sidebar and any dark ground (§4.7; `exports/`); the Ops Portal's frame draws it in its banner on a dark ground since redesign step R3, and the Ink sidebar will in step R4.

Do not create placeholder production logos using generated text or traced artwork.

**Status (23 October 2026).** The Product Owner supplied vector artwork (the primary logo, the symbol, a white logo, and a
pattern) and two low-resolution PNGs. The primary logo is the vector master and the symbol and the white logo are filed as
supplied; the high-resolution transparent PNG export is still missing (the supplied PNGs are 218 × 70 and 55 × 70). The
record, with checksums and what is used where, is [assets/brand/README.md](assets/brand/README.md).

---

## 20. Next design document

The next design artifact is:

`design/DESIGN_SYSTEM.md`

It should define, at minimum:

- final semantic color tokens and verified accessible pairs;
- typography tokens;
- spacing scale;
- radius/elevation rules;
- control boundaries;
- focus system;
- density rules;
- responsive principles;
- state presentation;
- token naming and platform mapping;
- initial implementation scope.

Technology choices such as Tailwind or Radix must be decided separately against the actual repository and must not be inferred from approval of this Brand Foundation.

---

## 21. Change discipline

Brand changes that affect identity should update this document before implementation diverges.

Design-system refinements that do not change the approved brand identity belong in `design/DESIGN_SYSTEM.md`.

Component-specific decisions belong in `design/COMPONENT_PATTERNS.md`.

Experience direction (page templates, inspiration, how a significant proposal is raised) belongs in `design/PRODUCT_DESIGN_DIRECTION.md`.

Do not duplicate the same rule across all four documents when one document clearly owns it.

---

## 22. Current decision summary

| Decision | Status |
|---|---|
| Professional + trustworthy + modern/premium character | **APPROVED** |
| Crimson + Ink visual direction | **APPROVED** |
| Balanced density model | **APPROVED** |
| Preserve existing Melarc logo identity | **APPROVED** |
| Existing PNG logo red sampled as `#BE1E2D` | **REFERENCE ONLY** |
| Existing PNG black sampled as `#000000` | **REFERENCE ONLY** |
| Interface crimson `#B4232E` | **REPLACED** by the logo red `#BE1E2D` as the brand crimson (`#F04B59` in the dark theme), which is no longer the primary-action color (Product Owner, 5 November 2026; [DESIGN_SYSTEM §4.3](DESIGN_SYSTEM.md#43-core-semantic-color-tokens), in force since step R2) |
| Interface ink `#172033` | **REPLACED** by `#0E1525` (5 November 2026; [DESIGN_SYSTEM §4.3](DESIGN_SYSTEM.md#43-core-semantic-color-tokens), in force since step R2) |
| Inter product typeface | **RECOMMENDED / NOT YET FINAL** |
| JetBrains Mono (operational codes only) | **APPROVED** 5 November 2026 and shipped since step R2, Latin subset, weights 500 and 600 ([DESIGN_SYSTEM §5.1](DESIGN_SYSTEM.md#51-typeface)) |
| Light and dark themes | **APPROVED for Version 1** (Product Owner, 5 November 2026) |
| Color roles: Ink carries the work, crimson carries the brand | **APPROVED** (Product Owner, 5 November 2026; §5.5) |
| Operational codes in a monospaced face (JetBrains Mono) | **APPROVED** (Product Owner, 5 November 2026; §6.4) |
| Tailwind | **NOT DECIDED HERE** |
| Radix | **NOT DECIDED HERE** |
| Original SVG/vector logo | **SUPPLIED BY THE PRODUCT OWNER, 23 October 2026** — filed as `design/assets/brand/master/melarc-logo-primary.svg` and used in the Ops frame; the owner confirms it as the approved master ([the brand README](assets/brand/README.md)) |
| Symbol-only production logo | **APPROVED 25 October 2026 as the Ops Portal's browser-tab icon (favicon) only** — filed as `exports/melarc-symbol.svg` and used as `apps/ops-web/public/favicon.svg`; no other use is approved, though the symbol is in provisional use as the mark of the side menu and the split screen (`BrandLockup`), from the owner's reference screenshot of 25 October 2026, **owner to confirm** ([the brand README](assets/brand/README.md)) |
| Dark-background logo | **APPROVED 5 November 2026** for the Ink sidebar and any dark ground (§4.7) — filed as `exports/melarc-logo-dark.svg`; drawn in the banner of the Ops Portal's frame on a dark ground since redesign step R3, and in the Ink sidebar from step R4 |

---

**End of Melarc Brand Foundation v1.1**
