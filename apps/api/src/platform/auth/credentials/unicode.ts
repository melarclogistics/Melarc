/**
 * Whether every surrogate code unit of the text is half of a pair. A lone surrogate is not text: the first UTF-8 encoder it meets
 * writes U+FFFD for it, so two different malformed strings would hash and compare as one. The credential rule refuses them "the
 * same way at every entry point and never silently encodes them to different bytes" (SECURITY_DESIGN.md §13.4a).
 *
 * In a `u`-mode pattern a valid pair is one astral code point and only a lone surrogate matches `\p{Surrogate}`.
 */
export function isWellFormedUnicode(text: string): boolean {
  return !/\p{Surrogate}/u.test(text);
}

/**
 * The number of Unicode code points in a well-formed text, counted no further than one past `stopAbove`, so that the work is
 * bounded by the limit being tested and not by the length of what was sent.
 */
export function codePointCount(text: string, stopAbove: number): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    // A high surrogate is followed by its low half, which belongs to the same code point.
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) index += 1;
    count += 1;
    if (count > stopAbove) break;
  }
  return count;
}
