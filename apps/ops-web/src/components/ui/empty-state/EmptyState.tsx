import type { ReactNode } from 'react';

import { Icon } from '../icon/Icon';
import './empty-state.css';

interface CommonProps {
  /** What is empty, in a few words: "Nothing is waiting". The screen's words; nothing here is product copy. */
  readonly heading: string;
  /** The level of the heading, so that the page's outline stays in order. */
  readonly headingLevel?: 2 | 3 | 4;
  /** Why, in a sentence. */
  readonly children: ReactNode;
  /**
   * Set when the empty result appears because of something that just happened, such as a filter: it is then announced politely. Leave it
   * off for one that is part of a page that is loading, which is read in order like any other text.
   */
  readonly announce?: boolean;
}

export type EmptyStateProps = CommonProps &
  (
    | {
        /** There is nothing: the list is empty, and that is the answer. It reads as good news, because a queue worked to empty is the goal. */
        readonly kind: 'none';
        /** The next useful thing to do, if there is one. */
        readonly action?: ReactNode;
      }
    | {
        /** There is something, and the filter hides all of it. The only useful thing to do is take the filter off, so an action is required. */
        readonly kind: 'filtered';
        readonly action: ReactNode;
      }
  );

const HEADING_ELEMENT = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/**
 * The empty state (COMPONENT_PATTERNS section 16): what is empty, whether that is expected, and the next useful action. It tells *none*
 * from *filtered to nothing*, because conflating them sends Ops hunting for a bug (surfaces/ops-portal.md section 7): `none` is a success
 * message, `filtered` is a neutral one that must come with the way to remove the filter. It never shows example rows.
 */
export function EmptyState(props: EmptyStateProps) {
  const { kind, heading, headingLevel = 2, children, announce = false, action } = props;
  const Heading = HEADING_ELEMENT[headingLevel];
  return (
    <div
      className={`ui-empty-state ui-empty-state--${kind}`}
      role={announce ? 'status' : undefined}
    >
      <Icon name={kind === 'none' ? 'success' : 'filter'} className="ui-empty-state__icon" />
      <div className="ui-empty-state__body">
        <Heading className="ui-empty-state__heading">{heading}</Heading>
        <p className="ui-empty-state__text">{children}</p>
        {action === undefined ? null : <div className="ui-empty-state__action">{action}</div>}
      </div>
    </div>
  );
}
