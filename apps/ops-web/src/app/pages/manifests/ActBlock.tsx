import type { ReactNode } from 'react';

import '../pickup/pickup-pages.css';

/**
 * One act a manifest page offers: a heading, what it does, and its control, or the permission it needs when the session does not hold it. What
 * is offered follows the record and the keys the session lists, and decides nothing: the server checks the key, the hub and the state.
 */
export function ActBlock({
  title,
  permission,
  holds,
  text,
  control,
}: {
  readonly title: string;
  readonly permission: string;
  readonly holds: boolean;
  readonly text: ReactNode;
  readonly control: ReactNode;
}) {
  return (
    <div className="pickup-act">
      <h3>{title}</h3>
      {holds ? (
        <>
          <p className="pickup-act__text">{text}</p>
          <div className="pickup-act__buttons">{control}</div>
        </>
      ) : (
        <p className="pickup-act__text">
          This needs the permission <code>{permission}</code>, which your session does not hold.
        </p>
      )}
    </div>
  );
}
