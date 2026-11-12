import './skeleton-v2.css';

export interface SkeletonBarProps {
  /** A CSS width: `60%`, `6rem`. The bar fills its room when it is left out. */
  readonly width?: string;
  /** A CSS height; the height of a line of text when it is left out. */
  readonly height?: string;
}

/**
 * One bar of a placeholder (COMPONENT_PATTERNS, *Skeleton v2*; the second half of redesign step R5): the part that a skeleton, a loading row and a loading card are made of. It is
 * decoration, hidden from assistive technology, in the border colour (the colour that is seen on a card in both themes), pulsing only where motion is welcome. The words that say that
 * the page is loading are the loading indicator's and never a skeleton's.
 */
export function SkeletonBar({ width, height }: SkeletonBarProps) {
  return (
    <span
      className="ui-skeleton-bar"
      aria-hidden="true"
      style={{
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      }}
    />
  );
}
