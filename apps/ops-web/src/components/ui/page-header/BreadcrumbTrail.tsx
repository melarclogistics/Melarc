import { Fragment } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '../../primitives/breadcrumb';
import { Link } from '../link/Link';
import './page-header.css';

/** A page above the current one, from the top of the trail down: where the link goes and what it is called. */
export interface BreadcrumbEntry {
  readonly label: string;
  readonly to: string;
}

/**
 * The pages above the current one, as a trail of links (the PageHeader's, and the record template's, which has the record's code for its title and so no PageHeader). Nothing
 * is drawn for an empty trail.
 */
export function BreadcrumbTrail({
  breadcrumb,
}: {
  readonly breadcrumb: readonly BreadcrumbEntry[];
}) {
  if (breadcrumb.length === 0) return null;
  return (
    <Breadcrumb aria-label="Breadcrumb" className="ui-page-head__trail">
      <BreadcrumbList>
        {breadcrumb.map((entry, index) => (
          // A trail is in a fixed order, and two steps may share an address (a list and its filtered view): the place in the trail and the words tell them apart.
          <Fragment key={`${String(index)}:${entry.label}`}>
            {index === 0 ? null : <BreadcrumbSeparator />}
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={entry.to}>{entry.label}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
