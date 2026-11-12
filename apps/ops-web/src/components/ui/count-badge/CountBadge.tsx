import { Badge } from '../../primitives/badge';
import './count-badge.css';

/** A count as the page writes a number: grouped by thousands, in the style of the portal's other figures. */
const NUMBER = new Intl.NumberFormat('en-GB');

/** The same, for a text that says a count in words (a tooltip, a card): one way of writing it, so that "1,234" is never "1234" in one place and not in another. */
export function formatCount(count: number): string {
  return NUMBER.format(count);
}

/**
 * How the badge is drawn on the page (COMPONENT_PATTERNS, *count badge*, the second half of redesign step R5): `subtle` is the neutral pair (the default, as it has always been),
 * `strong` is Ink with the figure in white (the current tab's count), and `on-crimson` is white at 18% over the brand crimson (a count on a crimson ground, the sidebar's current entry).
 */
export type CountBadgeVariant = 'subtle' | 'strong' | 'on-crimson';

export interface CountBadgeProps {
  /** The look of the badge. `subtle` is the neutral pair and the default; the sidebar's own grounds are `surface`, below, and need no variant. */
  readonly variant?: CountBadgeVariant;
  /** How many. A whole number from zero; the figure is drawn as it is, never capped (`99+` would hide the size of a queue). */
  readonly count: number;
  /**
   * What the number counts, said after it to someone who hears the page: "waiting for confirmation", "in progress". The number alone is
   * not a name, and a count of runs in progress beside *Manifests* is not a count of manifests, so the words go with it for a screen
   * reader and stay out of the way for the eye. Left out where the words beside the badge already say what it counts (a line that names the
   * queue next to its number): the number is then read as the number it is.
   */
  readonly meaning?: string;
  /**
   * The ground the badge is on: `page` is the page's own (no screen draws it yet: My work sets its figures in its own face), `shell` is the
   * sidebar's Ink, where the tokens of the shell take the place of the status pairs and where the current entry's filled ground gets a badge of
   * its own (`count-badge.css`).
   */
  readonly surface?: 'page' | 'shell';
}

/**
 * A count beside a name (task C1; COMPONENT_PATTERNS, *count badge*): a small pill with a number, from the Badge primitive and the tokens.
 * **The number is the figure the server counted and never a stand-in for one**: a count that is still being read or could not be read is
 * not drawn at all by whoever has none to give (`AC-QSUM-07`), and a `0` that was read is drawn quiet, so that a queue with nothing in it is
 * told from a queue that has work without either being mistaken for a count that is missing.
 *
 * The visible number is hidden from assistive technology and the whole phrase ("5 waiting for confirmation") is given to it in its place,
 * so that a screen reader says what the number is of and does not say the number twice.
 */
export function CountBadge({
  count,
  meaning,
  surface = 'page',
  variant = 'subtle',
}: CountBadgeProps) {
  return (
    <Badge
      variant="neutral"
      className="ui-count-badge"
      data-surface={surface}
      data-variant={variant}
      data-quiet={count === 0 ? 'true' : undefined}
    >
      {meaning === undefined ? (
        <span>{NUMBER.format(count)}</span>
      ) : (
        <>
          <span aria-hidden="true">{NUMBER.format(count)}</span>
          <span className="ui-count-badge__meaning">{`${NUMBER.format(count)} ${meaning}`}</span>
        </>
      )}
    </Badge>
  );
}
