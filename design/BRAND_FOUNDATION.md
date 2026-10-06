# Melarc Brand Foundation

> **Status:** ACTIVE FOUNDATION — approved brand direction; exact interface token values and production logo assets remain subject to the confirmations identified in this document  
> **Version:** 1.1  
> **Date:** 5 October 2026; revised 6 October 2026 (§11.1 permission wording, §19 asset layout) after the [bootstrap and design audit](../delivery/planning/MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md); no approved decision changed  
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

### 2.2 Provisional implementation values

The following values are working design inputs, not immutable brand law:

- interface primary crimson `#B4232E`;
- interface ink `#172033`;
- supporting neutral and semantic palette values in §5;
- Inter as the recommended product-interface typeface;
- exact spacing, radius, elevation, motion, and responsive values.

These values may be refined in the Design System when accessibility and real component usage are verified.

### 2.3 Open asset/design confirmations

The following remain open:

- original vector logo artwork, preferably SVG;
- authoritative source color values from the vector artwork;
- approved symbol-only logo variant;
- approved logo treatment for dark backgrounds;
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

---

## 5. Color foundation

## 5.1 Brand versus interface color

The **logo palette** and **interface palette** are related but distinct.

The logo should preserve its official source artwork.

The interface uses a darker crimson and ink foundation to improve product usability, depth, and accessibility.

This separation is intentional.

### 5.2 Working interface palette

| Role | Working value | Status | Intended use |
|---|---:|---|---|
| Brand/action crimson | `#B4232E` | Provisional exact value | Primary actions, active accents, selected brand moments |
| Crimson hover | `#971B26` | Provisional | Primary-action hover/pressed hierarchy |
| Crimson soft | `#FCEBED` | Provisional | Soft selection/accent backgrounds |
| Ink | `#172033` | Provisional | Primary text, dark navigation, structural emphasis |
| Page surface | `#F7F8FA` | Provisional | Main application background |
| Default surface | `#FFFFFF` | Provisional | Cards, panels, tables, forms |
| Secondary text | `#667085` | Provisional | Supporting copy |
| Subtle border | `#DDE1E7` | Provisional | Decorative/divider borders |
| Success | `#157A55` | Provisional | Positive state |
| Warning | `#B76E00` | **Needs accessible pairing** | Warning semantics |
| Danger | `#B4232E` | Provisional semantic token | Destructive/error semantics |
| Info | `#2563A6` | Provisional | Informational semantics |

### 5.3 Accessibility observations

Measured contrast against white for key proposed colors:

| Color | Contrast vs white | Interpretation |
|---|---:|---|
| `#B4232E` | 6.52:1 | Suitable for normal white text |
| `#971B26` | 8.40:1 | Strong white-text contrast |
| `#172033` | 16.27:1 | Strong primary-text contrast |
| `#667085` | 4.97:1 | Suitable for normal text on white |
| `#157A55` | 5.32:1 | Suitable for white-text treatment |
| `#B76E00` | 4.00:1 | **Insufficient for normal-size white text under a 4.5:1 target** |
| `#2563A6` | 6.15:1 | Suitable for normal white text |
| `#DDE1E7` | 1.31:1 | **Too subtle to be the sole required boundary of an input/control** |

The Design System must therefore define:

- a stronger interactive-control boundary than `#DDE1E7` where visual boundaries are required;
- verified warning foreground/background pairs;
- focus-ring colors and thickness;
- selected, hover, pressed, disabled, and visited states;
- accessible text/background pairs for badges and alerts.

### 5.4 Brand crimson versus danger

`brand/action crimson` and `status.danger` are **separate semantic concepts**, even if their provisional values are identical.

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

Use crimson deliberately for:

- primary action;
- active navigation accent;
- focused brand moments;
- selected/active emphasis where semantically appropriate.

Use ink, white, and restrained neutrals for most structural surfaces.

Recommended visual balance:

- **Ink:** authority and navigation;
- **White/neutral:** working area;
- **Crimson:** action and brand emphasis;
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
- use tabular numerals where the chosen font and implementation support them appropriately.

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

These show tone, not approved copy. Permission and approval wording belongs to the feature that owns the rule. It names
the permission or the deciding capability and never a role: [surfaces/ops-portal.md](../surfaces/ops-portal.md) §7
requires a refusal to read as an approver holding a named permission decides, "not *you lack access*", and "not a role
name".

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
crimson.700
ink.950
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
- `melarc-symbol.svg`, only after a symbol-only mark is approved (`exports/`);
- `melarc-logo-dark.svg`, only after a dark-background treatment is approved (`exports/`).

Do not create placeholder production logos using generated text or traced artwork.

Until the SVG master is obtained, retain the supplied PNG outside production asset decisions or use it only as an explicitly temporary reference where necessary.

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

Do not duplicate the same rule across all three documents when one document clearly owns it.

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
| Interface crimson `#B4232E` | **PROVISIONAL** |
| Interface ink `#172033` | **PROVISIONAL** |
| Inter product typeface | **RECOMMENDED / NOT YET FINAL** |
| Dark mode | **DEFERRED** |
| Tailwind | **NOT DECIDED HERE** |
| Radix | **NOT DECIDED HERE** |
| Original SVG/vector logo | **REQUIRED ASSET — MISSING** |
| Symbol-only production logo | **NOT YET APPROVED** |
| Dark-background logo | **NOT YET APPROVED** |

---

**End of Melarc Brand Foundation v1.1**
