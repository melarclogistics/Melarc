import type { ReactNode } from 'react';

import { PageHeading } from '../../PageHeading';
import { Button } from '../../primitives/button';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import { BreadcrumbTrail, type BreadcrumbEntry } from './BreadcrumbTrail';
import './page-header.css';

export type { BreadcrumbEntry };

/** How many the server stated, and what they are ("pickup requests"): the words go with the number for whoever hears the page. */
export interface PageCount {
  /** A whole number from zero, drawn as it is and never capped. */
  readonly value: number;
  readonly noun: string;
}

export type FreshnessState = 'idle' | 'refreshing' | 'failed';

/** How current the page's results are, and the way to make them current. The screen decides when and how it reads again; this draws what it says. */
export interface Freshness {
  /** `idle` (the last read answered), `refreshing` (a read is under way) or `failed` (the last read did not answer). Default `idle`. */
  readonly state?: FreshnessState;
  /** The moment of the last successful read, already written the way the portal writes a time ("09:42"). Nothing is drawn for a page never read. */
  readonly updatedAt?: string;
  readonly onRefresh: () => void;
}

export interface PageHeaderProps {
  /** The page title: the page's one level-one heading, which takes focus after a navigation (`PageHeading`). */
  readonly title: string;
  readonly description?: string;
  /** How many the server stated. Leave it out when none was stated, or while it is loading: a count is never drawn as 0 for want of an answer. */
  readonly count?: PageCount;
  readonly freshness?: Freshness;
  /** The pages above this one. */
  readonly breadcrumb?: readonly BreadcrumbEntry[];
  /** Actions of the whole page, such as a Button; one of them is the primary. They wrap below the title on a narrow screen. */
  readonly actions?: ReactNode;
}

const NUMBER = new Intl.NumberFormat('en-GB');

function FreshnessLine({ freshness }: { readonly freshness: Freshness }) {
  const { state = 'idle', updatedAt, onRefresh } = freshness;
  // A page that was never read says nothing, and has nothing to refresh.
  if (state === 'idle' && updatedAt === undefined) return null;
  const words =
    state === 'refreshing'
      ? 'Checking…'
      : state === 'failed'
        ? updatedAt === undefined
          ? 'Refresh failed.'
          : `Refresh failed. Last successful check: ${updatedAt}`
        : `Updated ${updatedAt ?? ''}`;
  return (
    <p className="ui-page-head__freshness">
      <span role="status">{words}</span>
      <span aria-hidden="true">·</span>
      <Button
        type="button"
        variant="link"
        className="ui-page-head__refresh"
        aria-busy={state === 'refreshing' ? true : undefined}
        onClick={() => {
          // One read at a time: a press while a read is under way is that read's, and neither cancels it nor starts another.
          if (state !== 'refreshing') onRefresh();
        }}
      >
        Refresh
      </Button>
    </p>
  );
}

/**
 * The header of a page (COMPONENT_PATTERNS, *PageHeader, the kit's*): the title, how many there are where the server stated a count, how fresh the
 * results are and the way to refresh them, the pages above, and the page's actions. It composes `PageHeading`, the page's one level-one heading, and
 * never replaces it, so the move of focus after a navigation keeps working. It never draws a number it was not given, and a count of 0 is a count
 * that was read.
 */
export function PageHeader({
  title,
  description,
  count,
  freshness,
  breadcrumb,
  actions,
}: PageHeaderProps) {
  return (
    <div className="ui-page-head">
      {breadcrumb === undefined ? null : <BreadcrumbTrail breadcrumb={breadcrumb} />}
      <div className="ui-page-head__row">
        <div className="ui-page-head__text">
          <div className="ui-page-head__titleline">
            <PageHeading>{title}</PageHeading>
            {count === undefined ? null : (
              <span
                className="ui-page-head__count"
                data-quiet={count.value === 0 ? 'true' : undefined}
              >
                <span aria-hidden="true">{NUMBER.format(count.value)}</span>
                <VisuallyHidden>{`${NUMBER.format(count.value)} ${count.noun}`}</VisuallyHidden>
              </span>
            )}
          </div>
          {description === undefined ? null : (
            <p className="ui-page-head__description">{description}</p>
          )}
          {freshness === undefined ? null : <FreshnessLine freshness={freshness} />}
        </div>
        {actions === undefined ? null : <div className="ui-page-head__actions">{actions}</div>}
      </div>
    </div>
  );
}
