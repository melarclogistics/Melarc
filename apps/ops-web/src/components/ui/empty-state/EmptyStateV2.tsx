import { useEffect, useRef, type ReactNode } from 'react';

import './empty-state-v2.css';

/** What kind of nothing it is: there is none yet (`empty`), a filter hides all there is (`filtered-empty`), or the queue was worked to nothing and that is the goal (`all-clear`). */
export type EmptyStateVariant = 'empty' | 'filtered-empty' | 'all-clear';

interface CommonProps {
  /** What is empty, in a few words: "Nothing is waiting". The screen's words. */
  readonly title: string;
  /** The level of the heading, so that the page's outline stays in order. */
  readonly headingLevel?: 2 | 3 | 4;
  /** One line: why, or what it means. */
  readonly children: ReactNode;
  /**
   * Set when the empty result appears because of something that just happened, such as a filter: it is then announced politely, by a region that is in the page before it
   * speaks (a region that arrives with its words is not announced by most screen readers) and says the title.
   */
  readonly announce?: boolean;
}

export type EmptyStateV2Props = CommonProps &
  (
    | {
        readonly variant: 'empty' | 'all-clear';
        /** The next useful thing to do, if there is one. */
        readonly action?: ReactNode;
      }
    | {
        readonly variant: 'filtered-empty';
        /** There is something, and the filter hides all of it: the one useful thing is to take the filter off, so the way to do it is required. */
        readonly action: ReactNode;
      }
  );

const HEADING_ELEMENT = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/**
 * The empty state, version 2 (COMPONENT_PATTERNS, *EmptyState v2*; the second half of redesign step R5): the 10px square of the brand crimson that marks a place in the portal's
 * own way, a title, one line and an optional action, on the page with no frame. It tells the three kinds of nothing apart, because conflating them sends Ops hunting for a bug:
 * `empty` (nothing yet), `filtered-empty` (something, hidden by a filter: the way to take the filter off is required) and `all-clear` (worked to nothing, which is the goal, and
 * reads as good news in the success tone). It never shows example rows. The earlier `EmptyState` (section 16) stays ACTIVE until the screens move.
 */
export function EmptyStateV2(props: EmptyStateV2Props) {
  const { variant, title, headingLevel = 2, children, announce = false, action } = props;
  const Heading = HEADING_ELEMENT[headingLevel];
  // The region is mounted empty and given the title in an effect, so that the words are a change of a region that was there. It is written through its element and not held
  // in state: a state set in an effect would draw the page twice for a line of text that only the region needs.
  const region = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (region.current !== null) region.current.textContent = announce ? title : '';
  }, [announce, title]);
  return (
    <div className={`ui-empty-v2 ui-empty-v2--${variant}`} data-variant={variant}>
      {announce ? <p ref={region} role="status" className="ui-visually-hidden" /> : null}
      <span className="ui-empty-v2__motif" aria-hidden="true" />
      <Heading className="ui-empty-v2__title">{title}</Heading>
      <p className="ui-empty-v2__line">{children}</p>
      {action === undefined ? null : <div className="ui-empty-v2__action">{action}</div>}
    </div>
  );
}
