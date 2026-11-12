# Brand assets

The canonical home of the Melarc logo files. The layout and the rules of use are owned by [DESIGN_SYSTEM.md](../../DESIGN_SYSTEM.md) §26; the logo rules by [BRAND_FOUNDATION.md](../../BRAND_FOUNDATION.md) §4. This file records where each file came from and who approved it (§26.1).

Every file here was supplied by the Product Owner on 23 October 2026, as vector artwork they made, in the folder `design/assets/`. Nothing here was drawn, traced, recoloured or edited by an assistant: each file is a byte-for-byte copy of the supplied file named in the table, which stays where the owner put it.

| File | Supplied as | SHA-256 | Status |
|---|---|---|---|
| `master/melarc-logo-primary.svg` | `Transparent Logo.svg` (viewBox 217.24 × 69.34: the symbol, the black **Melarc** wordmark and the red **LOGISTICS** descriptor, on a transparent background) | `76c430d65af3522108c8a18150886c27e7cf096fbfb41ffe1cd3b9515baeedf1` | The primary vector master. Supplied by the Product Owner as their artwork, and used by the Ops Portal frame because they told the build to use their logo (23 October 2026). **Receipt is not an approval of any use, and not of any other variant**: approving this file as the product mark is **owner to confirm** |
| `exports/melarc-logo-dark.svg` | `Transparent White  Logo.svg` (two spaces in the supplied name; all white, transparent background) | `0b3384e98834a9b16360ff757b50d9c930fd08636d945b01dda9245004356890` | Filed as supplied. **Approved by the Product Owner on 5 November 2026 as the horizontal Melarc Logistics lockup for the Ink sidebar and any dark ground** ([BRAND_FOUNDATION.md](../../BRAND_FOUNDATION.md) §4.7, §19). The Ops Portal draws it in the banner of its frame (the sign-in screens and the neutral pages) whenever the dark theme applies, since redesign step R3, and at the head of the Ink sidebar in both themes since redesign step R4 (about 132 by 42, its own file: `apps/ops-web/src/assets/brand/melarc-logo-dark.svg`) |
| `exports/melarc-symbol.svg` | `Logo Icon.svg` (the symbol alone, viewBox 54.44 × 69.33) | `5bd8d85cb5d7a9395c2261476c8523f3586599789960696992e6b26fb2348c95` | Filed as supplied. **Approved by the Product Owner on 25 October 2026 as the browser-tab icon (favicon) of the Ops Portal, and for no other use**, after seeing it at tab sizes on a light and a dark tab (on a dark tab its black part nearly disappears; it is approved as it is). No app icon or installable icon uses it until that use is approved too. **One other use is in place, provisionally: the mark of the Ops Portal's sidebar when it is the 64px rail, and of the split screen's band** (`BrandLockup`, on a white tile beside the product's name as text, which the rail has no room for and shows as the tile alone), put there from the Product Owner's reference screenshot of 25 October 2026, which shows a mark and the name at the head of the menu (the full sidebar draws the all-white lockup instead since redesign step R4). That in-page use is **owner to confirm**, and is withdrawn by taking the image out of `BrandLockup`. Its runtime copy is `apps/ops-web/public/favicon.svg` |

Supplied and **not filed here**, because no row of the structure in §26 is for them. They stay in `design/assets/`, unchanged:

- `Logo On Black BG.svg`: the white logo on a black rectangle. It is a composed background, not a transparent export.
- `Pattern.svg`: a brand pattern. No pattern rule exists in the foundation yet.
- `Logo.png` (218 × 70) and `Logo Icon.png` (55 × 70): low-resolution rasters. `melarc-logo-primary.png` in `exports/` is the *high-resolution* transparent export ([BRAND_FOUNDATION.md](../../BRAND_FOUNDATION.md) §4.3), which these are not, so it is not made from them.

## Runtime copies

A runtime copy lives with the application that serves it and is copied from here, never edited there ([DESIGN_SYSTEM.md](../../DESIGN_SYSTEM.md) §26.1).

| Application | Copy | Test |
|---|---|---|
| Ops Portal | `apps/ops-web/src/assets/brand/melarc-logo-primary.svg` | `apps/ops-web/test/logo.test.ts` compares it with `master/melarc-logo-primary.svg` byte for byte, and `test/build.test.ts` proves the build ships it as its own file |
| Ops Portal (the all-white lockup, in the banner of the frame on a dark ground) | `apps/ops-web/src/assets/brand/melarc-logo-dark.svg` | `apps/ops-web/test/logo.test.ts` compares it with `exports/melarc-logo-dark.svg` and with the file as supplied byte for byte, and holds this README's checksum; `test/build.test.ts` proves the build ships it as its own file; `src/app/frame-logo.test.tsx` proves that `AppFrame` draws it when the dark theme applies, by the root's `data-theme` or the system's setting |
| Ops Portal (browser-tab icon) | `apps/ops-web/public/favicon.svg` | `apps/ops-web/test/favicon.test.ts` compares it with `exports/melarc-symbol.svg` byte for byte and with this README's checksum, and `test/build.test.ts` proves the build ships it at `/favicon.svg` |
| Ops Portal (the mark of the sidebar's rail and the split screen, provisional) | the same file, served as `/favicon.svg`, drawn by `apps/ops-web/src/components/brand/BrandLockup.tsx` | `test/favicon.test.ts` holds this README and `BRAND_FOUNDATION.md` to saying that this use is waiting for the owner, for as long as `BrandLockup` draws it |

`packages/brand-assets/` is created when a second application needs the same files, not before.
