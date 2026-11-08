# Authentication screen photographs

The photographs of the split-screen layout of the pre-sign-in screens (`/sign-in`, `/sign-in/mfa`, `/setup/credential`, `/setup/mfa`,
`/setup/mfa/complete`). The layout is owned by [DESIGN_SYSTEM.md](../../../../../design/DESIGN_SYSTEM.md) §13.1 and
[COMPONENT_PATTERNS.md](../../../../../design/COMPONENT_PATTERNS.md) §12.7; which photograph goes with which screen is the one table in
`src/app/pages/pre-sign-in/auth-art.ts`.

The originals are the Product Owner's photographs, supplied on 25 October 2026 in `design/images/` (4 files, 6 to 12 MB each, 5253 to 7388 px
wide). They stay there, unchanged. A browser cannot be sent files of that size, so the application serves the web copies in this folder.
**The licence and any attribution that the photographs carry are the Product Owner's to confirm: this repository does not know them.**

## How the copies were made

The same steps for every file, and nothing else: the EXIF orientation applied, **every metadata block dropped** (the camera, the lens, the
place and the time of a photograph do not go to a visitor), the long edge resized to 1800 px (Lanczos), and saved as WebP at quality 78,
method 6. No crop, no colour change, no overlay and no text was added to the pixels (made with Pillow 12.3.0 on 25 October 2026).
`test/auth-art.test.ts` holds each copy to its recorded checksum, its size budget and the absence of metadata.

| Copy              | Source (`design/images/`) | Source SHA-256                                                     | Source size | Copy size                  | Copy SHA-256                                                       |
| ----------------- | ------------------------- | ------------------------------------------------------------------ | ----------- | -------------------------- | ------------------------------------------------------------------ |
| `auth-art-1.webp` | `image 1.jpg`             | `4485fa2fc26e87ccabd6779292b870b95c2920c5d5f9b529e7c7e6dea01215e2` | 5500 × 3666 | 1800 × 1200, 79,618 bytes  | `d5667524ae924bd16cdfe69282cc76ad41e9c973c58657ff399f5729426f0c83` |
| `auth-art-2.webp` | `image 2.jpg`             | `ba35fe98543bbb13f3dd6c49cf3c45f488a96f0c3e43969a03e51f2a57245dbe` | 5568 × 3712 | 1800 × 1200, 265,930 bytes | `d0685a3ae7befaa039a6b9e17fe45182fab8ac4132b33938b17f634bb690d4ca` |
| `auth-art-3.webp` | `image 3.jpg`             | `16b304c405cecc64b59fc89a5186b0b3c9efd32821482fa8fb2cd261e17e70a3` | 7388 × 5086 | 1800 × 1239, 58,398 bytes  | `0f3de779e4e0b83df1672d8bff56ca95a137e46c0f598dfd27830b1cb1f129e9` |
| `auth-art-4.webp` | `image 4.JPG`             | `2be0e0e07c21b8c06fc6a4b62de2c7cbe9ff665b600c4beb93eed34d3240a0ab` | 5253 × 3502 | 1800 × 1200, 67,386 bytes  | `a570e38a96d5ac071515ec666bb547c3430c4786147840aa011db902fa78158f` |

To add or change a photograph: put the original in `design/images/`, make its copy with the same settings, name it `auth-art-N.webp`, record
its row here, and name the screen it belongs to in `auth-art.ts`. Never edit a copy by hand.
