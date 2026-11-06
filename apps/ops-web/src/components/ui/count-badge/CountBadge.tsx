import { Badge } from '../../primitives/badge';
import './count-badge.css';

/** A count as the page writes a number: grouped by thousands, in the style of the portal's other figures. */
const NUMBER = new Intl.NumberFormat('en-GB');

export interface CountBadgeProps {
  /** How many. A whole number from zero; the figure is drawn as it is, never capped (`99+` would hide the size of a queue). */
  readonly count: number;
  /**
   * What the number counts, said after it to someone who hears the page: "waiting for confirmation", "in progress". The number alone is
   * not a name, and a count of runs in progress beside *Manifests* is not a count of manifests, so the words go with it for a screen
   * reader and stay out of the way for the eye. Left out where the words beside the badge already say what it counts (a line of the
   * landing, whose link is the queue's name): the number is then read as the number it is.
   */
  readonly meaning?: string;
  /**
   * The ground the badge is on: `page` is the page's own (the landing), `shell` is the side menu's Ink, where the tokens of the shell take
   * the place of the status pairs and where the current entry's filled ground gets a badge of its own (`count-badge.css`).
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
export function CountBadge({ count, meaning, surface = 'page' }: CountBadgeProps) {
  return (
    <Badge
      variant="neutral"
      className="ui-count-badge"
      data-surface={surface}
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
