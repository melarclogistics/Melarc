import { useEffect, useState } from 'react';

import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import { animate, useMotion } from '../motion/motion';
import './stat-tile.css';

export interface StatTileProps {
  /** What the figure counts, in a few words: "Waiting for confirmation". */
  readonly label: string;
  /**
   * The figure the server stated. A number is grouped as the portal writes figures; text (an amount the page formatted) is drawn as it is. Leave it out
   * when none was stated: the tile says it is not available. **A missing figure is never drawn as 0**, and a sample is never a result.
   */
  readonly value?: number | string | null;
  /** One short line under the figure: where it comes from or how old it is ("Oldest: 3 hours"). */
  readonly caption?: string;
  /** The figure is being read: a bar stands where it will be, and nothing is drawn as a value. */
  readonly loading?: boolean;
  /** Counts the figure up from 0 once, the first time it is shown. Off under reduced motion. Only for a number. */
  readonly countUp?: boolean;
}

const NUMBER = new Intl.NumberFormat('en-GB');

/**
 * The number to draw while a figure counts: 0 up to `target` over `motion.highlight`, once, and `null` when it is not counting (it was not asked to, motion is
 * reduced, the count has played, or there is no figure): the caller then draws the figure itself.
 */
function useCountedFigure(target: number | null, countUp: boolean): number | null {
  const motion = useMotion();
  const counting = countUp && !motion.reduced && target !== null;
  // It starts at 0, so that the final figure is never drawn first and then taken back.
  const [shown, setShown] = useState(0);
  // Played once: later changes of the figure are shown at once, not counted again.
  const [played, setPlayed] = useState(false);

  useEffect(() => {
    if (!counting || played) return;
    const controls = animate(0, target, {
      ...motion.transition('highlight'),
      onUpdate: (latest) => {
        setShown(Math.round(latest));
      },
      onComplete: () => {
        setPlayed(true);
      },
    });
    return () => {
      controls.stop();
    };
  }, [counting, played, target, motion]);

  return counting && !played ? shown : null;
}

/**
 * A figure the server states, with its label and a caption (COMPONENT_PATTERNS, *StatTile*): an 11.5px muted capital label, a 22px bold figure in tabular
 * numbers, and an optional line. It draws what it is given and works nothing out. While the figure counts up, assistive technology reads the final figure
 * (the moving one is hidden), so no one hears 3, 17, 42 on the way to 120.
 */
export function StatTile({
  label,
  value,
  caption,
  loading = false,
  countUp = false,
}: StatTileProps) {
  const number = typeof value === 'number' ? value : null;
  const counted = useCountedFigure(loading ? null : number, countUp);
  const missing = value === undefined || value === null;
  const final = typeof value === 'number' ? NUMBER.format(value) : (value ?? '');
  return (
    <div className="ui-stat-tile" aria-busy={loading ? true : undefined}>
      <p className="ui-stat-tile__label">{label}</p>
      {loading ? (
        <>
          <p className="ui-stat-tile__value" aria-hidden="true">
            <span className="ui-stat-tile__placeholder" />
          </p>
        </>
      ) : missing ? (
        <p className="ui-stat-tile__value ui-stat-tile__value--missing">
          <span aria-hidden="true">—</span>
          <VisuallyHidden>Not available</VisuallyHidden>
        </p>
      ) : (
        <p className="ui-stat-tile__value">
          {counted === null ? (
            final
          ) : (
            <>
              <span aria-hidden="true">{NUMBER.format(counted)}</span>
              <VisuallyHidden>{final}</VisuallyHidden>
            </>
          )}
        </p>
      )}
      {caption === undefined ? null : <p className="ui-stat-tile__caption">{caption}</p>}
      {/* In the page before it says anything (a region that arrives with its words is not announced by most screen readers); out of the layout, so that it adds no gap. */}
      <p role="status" className="ui-visually-hidden">
        {loading ? `Loading: ${label}` : ''}
      </p>
    </div>
  );
}
