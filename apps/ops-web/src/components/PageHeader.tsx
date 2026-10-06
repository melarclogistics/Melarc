import type { ReactNode } from 'react';

import './page-header.css';
import { PageHeading } from './PageHeading';

export interface PageHeaderProps {
  /** The page title: the one level-one heading, which takes focus after a navigation. */
  readonly title: string;
  readonly description?: string;
  /** Actions that belong to the whole page, such as a Button. They wrap below the title on a narrow screen. */
  readonly actions?: ReactNode;
}

/**
 * The initial PageHeader (COMPONENT_PATTERNS section 11): the title, an optional description and optional actions. It
 * composes the existing PageHeading and never replaces it, so the focus move after a navigation keeps working. Context
 * and breadcrumbs are built when a screen first needs them.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="ui-page-header">
      <div className="ui-page-header__text">
        <PageHeading>{title}</PageHeading>
        {description === undefined ? null : (
          <p className="ui-page-header__description">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="ui-page-header__actions">{actions}</div>}
    </div>
  );
}
