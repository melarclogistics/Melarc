import { SkeletonBar } from './SkeletonBar';

export interface SkeletonCardProps {
  /** How many lines of body: a whole number from 1 to 8. Three by default. */
  readonly lines?: number;
  /** Draw a title bar at the top, as a card with a header has one. */
  readonly header?: boolean;
}

const MAX_LINES = 8;
const LINE_WIDTHS = ['100%', '86%', '64%'] as const;

/**
 * A card that is loading (COMPONENT_PATTERNS, *Skeleton v2*; the second half of redesign step R5): the shape of a Panel or a Card, with its radius, its border and its padding, a title
 * bar and some lines, so that the layout keeps still while the content is on the way. It is decoration, hidden from assistive technology.
 */
export function SkeletonCard({ lines = 3, header = true }: SkeletonCardProps) {
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
    throw new RangeError(`A loading card has between 1 and ${String(MAX_LINES)} lines.`);
  }
  return (
    <div className="ui-skeleton-card" aria-hidden="true">
      {header ? (
        <div className="ui-skeleton-card__header">
          <SkeletonBar width="40%" height="1rem" />
        </div>
      ) : null}
      <div className="ui-skeleton-card__body">
        {Array.from({ length: lines }, (_line, line) => (
          <SkeletonBar key={line} width={LINE_WIDTHS[line % LINE_WIDTHS.length]} />
        ))}
      </div>
    </div>
  );
}
