import { useEffect, useRef } from 'react';

import { Button } from '../button/Button';
import { Icon } from '../icon/Icon';
import './queue-pager.css';

export interface QueuePagerProps {
  /** Names the pages: "Pages of pickup requests". */
  readonly label: string;
  /** What the queue lists, one and many: "request", "requests". */
  readonly noun: { readonly one: string; readonly other: string };
  /** How many rows the page shows. */
  readonly shown: number;
  /** The page shown, counted from 1. */
  readonly page: number;
  /** The server said more follow. A queue pages by an opaque token and never states a total, so the count says what the page holds and no more. */
  readonly hasNext: boolean;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
}

/**
 * What follows the table of a paged queue (`table.footer` of the queue workspace; COMPONENT_PATTERNS, *QueueWorkspace*): a line that says how many rows the page shows (never a total:
 * the server pages by token and states none) in a region that is in the page before it has anything to say, and the way to the next and the previous page, which the person
 * asks for and the page answers by reading again. Nothing is drawn for a queue of one page that holds nothing to say.
 *
 * **The region is in the page from the first paint, empty, and the words come into it afterwards** (the review of 5edada2): a region that arrives with its words in it is not announced by
 * most screen readers, so "Showing 25 requests" was heard only after the second page. The words are written into the region by an effect, and React draws nothing inside it.
 */
export function QueuePager({
  label,
  noun,
  shown,
  page,
  hasNext,
  onNext,
  onPrevious,
}: QueuePagerProps) {
  const count = `Showing ${String(shown)} ${shown === 1 ? noun.one : noun.other}${
    page > 1 ? ` on page ${String(page)}` : ''
  }.${hasNext ? ' More follow on the next page.' : ''}`;
  const region = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (region.current !== null) region.current.textContent = count;
  }, [count]);
  return (
    <div className="ui-queue-pager">
      <p ref={region} className="ui-queue-pager__count" role="status" />
      {page > 1 || hasNext ? (
        <nav className="ui-queue-pager__nav" aria-label={label}>
          {page > 1 ? (
            <Button type="button" variant="secondary" onClick={onPrevious}>
              <Icon name="previous" size="sm" />
              Previous page
            </Button>
          ) : null}
          {hasNext ? (
            <Button type="button" variant="secondary" onClick={onNext}>
              Next page
              <Icon name="next" size="sm" />
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
