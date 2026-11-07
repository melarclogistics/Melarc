/**
 * The motion tokens of the design system (DESIGN_SYSTEM section 9), for the code that animates in JavaScript. `tokens.css` is the one source: a
 * value is read from the root's custom property when it is used, so a theme or a media rule that changes the token changes the animation too (under
 * `prefers-reduced-motion: reduce` every duration token is `0ms`, and so these are zero). The numbers below are what the file holds, and are used only
 * where no stylesheet is loaded (a unit test); `test/motion-tokens.test.ts` fails if they drift from the file.
 */
export type MotionDuration = 'fast' | 'normal' | 'slow' | 'highlight';
export type MotionEase = 'enter' | 'exit';
/** The four numbers of a `cubic-bezier()`, the form Motion takes an easing in. */
export type CubicBezier = readonly [number, number, number, number];

export const MOTION_FALLBACK = {
  /** Milliseconds: hover and press, menus and tabs, panels and sheets, a changed row. */
  duration: { fast: 120, normal: 200, slow: 280, highlight: 900 },
  ease: { enter: [0.2, 0.8, 0.2, 1], exit: [0.4, 0, 1, 1] },
} as const satisfies {
  duration: Record<MotionDuration, number>;
  ease: Record<MotionEase, CubicBezier>;
};

function readToken(property: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(property).trim();
}

/** A CSS time (`280ms`, `0.28s`, `0`) in milliseconds, or undefined for text that is not one. */
export function millisecondsOf(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)?$/i.exec(text.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  return (match[2] ?? 's').toLowerCase() === 'ms' ? value : value * 1000;
}

/** The four numbers of a `cubic-bezier(a, b, c, d)`, or undefined for text that is not one. */
export function bezierOf(text: string): CubicBezier | undefined {
  const match = /^cubic-bezier\(\s*([^,]+),([^,]+),([^,]+),([^)]+)\)$/i.exec(text.trim());
  if (match === null) return undefined;
  const numbers = match.slice(1, 5).map((part) => Number(part.trim()));
  const [a, b, c, d] = numbers;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return numbers.every((value) => Number.isFinite(value)) ? [a, b, c, d] : undefined;
}

/** A duration token in seconds, which is what Motion takes: `--motion-slow` is 0.28, and 0 under reduced motion. */
export function durationSeconds(name: MotionDuration): number {
  const read = millisecondsOf(readToken(`--motion-${name}`));
  return (read ?? MOTION_FALLBACK.duration[name]) / 1000;
}

/** An easing token as Motion takes it. */
export function easeCurve(name: MotionEase): CubicBezier {
  return bezierOf(readToken(`--motion-ease-${name}`)) ?? MOTION_FALLBACK.ease[name];
}
