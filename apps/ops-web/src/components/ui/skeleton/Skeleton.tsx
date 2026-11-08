import './skeleton.css';

export interface SkeletonProps {
  /** How many lines of content it stands for: a whole number from 1 to 20. */
  readonly lines?: number;
}

const MAX_LINES = 20;

/**
 * A placeholder for content that is on its way (COMPONENT_PATTERNS section 17). It is decoration: hidden from assistive technology, with
 * no words and no role, and always beside a loading indicator, which is what says that the page is loading. It keeps the layout from
 * jumping when the content arrives; it never stands in for the loading words, and it stops moving for a person who asked for less
 * motion.
 */
export function Skeleton({ lines = 3 }: SkeletonProps) {
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
    throw new RangeError(`A skeleton has between 1 and ${String(MAX_LINES)} lines.`);
  }
  return (
    <div className="ui-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span className="ui-skeleton__line" key={index} />
      ))}
    </div>
  );
}
