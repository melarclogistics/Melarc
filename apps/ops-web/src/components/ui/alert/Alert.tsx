import type { ReactNode } from 'react';

import { Icon } from '../icon/Icon';
import './alert.css';

export type AlertVariant = 'danger' | 'success';

export interface AlertProps {
  readonly variant: AlertVariant;
  readonly title?: string;
  /** The message: approved presentation copy, never the API's diagnostic `message` (COMPONENT_PATTERNS section 33). */
  readonly children: ReactNode;
  /** A secondary action after the message, such as a link. */
  readonly action?: ReactNode;
  /**
   * Set when the alert is inserted into a page that is already showing, because of something that just happened: a
   * `danger` alert is then announced at once and a `success` one politely. Leave it off for a notice that is part of
   * the page when it loads, which is read in order like any other text.
   */
  readonly announce?: boolean;
}

/**
 * The initial Alert (COMPONENT_PATTERNS section 9): `danger` and `success`. The meaning is in the icon and the words;
 * the colours only support them. The other status variants are built when a screen first needs them.
 */
export function Alert({ variant, title, children, action, announce = false }: AlertProps) {
  const role = announce ? (variant === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={`ui-alert ui-alert--${variant}`} role={role}>
      {/* The meaning is in the words; the picture supports it, and is the same one every failure and every success has. */}
      <Icon name={variant === 'danger' ? 'warning' : 'success'} className="ui-alert__icon" />
      <div className="ui-alert__body">
        {title === undefined ? null : <p className="ui-alert__title">{title}</p>}
        <div className="ui-alert__message">{children}</div>
        {action === undefined ? null : <div className="ui-alert__action">{action}</div>}
      </div>
    </div>
  );
}
