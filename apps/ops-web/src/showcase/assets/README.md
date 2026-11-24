# Showcase sample label

`label-sample.png` is the photo of a parcel label that the photo viewer's specimen of the kit showcase (`/__showcase/kit/photos`, _Open the sample label_) is looked at with: **800 x 1200 pixels, portrait**, the shape of a 4 x 6 inch label at 200 dots per inch, which is what the viewer's zoom and turn are for. It is **drawn, never photographed**: no real parcel, person, address or code is in it, only bars that stand for small print, a barcode-like block, a red square in the top-left corner and a blue bar along the right-hand edge, so that no turn of the photo looks like another.

It is made by `make-label-sample.mjs` (Node only, no dependency; the same bytes every time) and is held to its size by `test/showcase-label-sample.test.ts`, because the viewer's browser specs measure the photo against it. Only the showcase imports it (`?no-inline`: the portal's policy refuses a `data:` picture), so the production build holds no trace of it.
