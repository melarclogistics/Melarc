import type { ReactNode } from 'react';

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

function AlertIcon({ variant }: { readonly variant: AlertVariant }) {
  return (
    <svg
      className="ui-alert__icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="8.25" />
      {variant === 'danger' ? (
        <>
          <path d="M10 5.75v5" />
          <path d="M10 13.75h.01" />
        </>
      ) : (
        <path d="M6.25 10.25l2.5 2.5 5-5.25" />
      )}
    </svg>
  );
}

/**
 * The initial Alert (COMPONENT_PATTERNS section 9): `danger` and `success`. The meaning is in the icon and the words;
 * the colours only support them. The other status variants are built when a screen first needs them.
 */
export function Alert({ variant, title, children, action, announce = false }: AlertProps) {
  const role = announce ? (variant === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={`ui-alert ui-alert--${variant}`} role={role}>
      <AlertIcon variant={variant} />
      <div className="ui-alert__body">
        {title === undefined ? null : <p className="ui-alert__title">{title}</p>}
        <div className="ui-alert__message">{children}</div>
        {action === undefined ? null : <div className="ui-alert__action">{action}</div>}
      </div>
    </div>
  );
}
