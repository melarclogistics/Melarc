import type { ReactNode } from 'react';

import { OperationalCode } from '../code/OperationalCode';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import './description-list.css';

/** One fact of a record: what it is, and what the server states of it. */
export interface DescriptionItem {
  /** What the fact is, in one to three words: "Hub". */
  readonly label: string;
  /**
   * The value, as the page draws it (text, a StatusBadge, an amount, a link). Leave it out when the server stated none: it is drawn as the words for
   * "not recorded", never as a blank and never as a dash or a 0 that would read as an answer (COMPONENT_PATTERNS section 24.1).
   */
  readonly value?: ReactNode;
  /** The value is an operational code: it is set in the monospaced face and never shortened. A text value only. */
  readonly code?: boolean;
}

export interface DescriptionListProps {
  readonly items: readonly DescriptionItem[];
  /** A section label above the facts ("Pickup"): small capitals, muted. Facts are grouped by meaning and labelled, not listed in one run. */
  readonly heading?: string;
  /** The level of the heading, so that the page's outline stays in order. Default 3. */
  readonly headingLevel?: 2 | 3 | 4;
  /** The facts are being read: the labels stay and every value is a placeholder. A value is never drawn before it arrives. */
  readonly loading?: boolean;
  /** The words for a value the server did not state. Default "Not recorded". */
  readonly missingText?: string;
}

const HEADING = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/**
 * The facts of a record, labelled (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *DescriptionList*): a `<dl>` with a label column of 110px, muted
 * labels, and values that may hold operational codes. It draws what the server stated and no more: a value that was not stated says so in words. Under 24rem
 * (or with enlarged text) a label sits over its value, so nothing is squeezed.
 */
export function DescriptionList({
  items,
  heading,
  headingLevel = 3,
  loading = false,
  missingText = 'Not recorded',
}: DescriptionListProps) {
  const Heading = HEADING[headingLevel];
  return (
    <div className="ui-description-list">
      {heading === undefined ? null : (
        <Heading className="ui-description-list__heading">{heading}</Heading>
      )}
      <dl className="ui-description-list__list" aria-busy={loading ? true : undefined}>
        {items.map((item, index) => (
          // A record may state a kind of fact twice (a second phone): the place in the list and the label tell the facts apart.
          <div key={`${String(index)}:${item.label}`} className="ui-description-list__pair">
            <dt className="ui-description-list__label">{item.label}</dt>
            <dd className="ui-description-list__value">
              {loading ? (
                <span className="ui-description-list__placeholder" aria-hidden="true" />
              ) : item.value === undefined || item.value === null ? (
                <span className="ui-description-list__missing">{missingText}</span>
              ) : item.code === true && typeof item.value === 'string' ? (
                <OperationalCode>{item.value}</OperationalCode>
              ) : (
                item.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {loading ? (
        <p role="status" className="ui-description-list__status">
          <VisuallyHidden>Loading the details</VisuallyHidden>
        </p>
      ) : null}
    </div>
  );
}
