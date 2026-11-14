import type { ReactNode } from 'react';

import { Icon } from '../icon/Icon';
import './lock-indicator.css';

/**
 * Who holds an **advisory** lock on a record, as the page was told:
 *
 * - `free`: nobody holds it;
 * - `yours`: the person holds it;
 * - `other`: somebody else holds it;
 * - `unknown`: the page could not find out (it asked and nothing answered, or it has not asked yet).
 *
 * The indicator draws what the page was told and decides nothing: it does not know what the lock is for, how long it lasts or who may take it over, and **a lock that is advisory is never drawn
 * as a gate**. Whether anything is refused is the server's, for the record's own facts.
 */
export type LockHolder = 'free' | 'yours' | 'other' | 'unknown';

export interface LockIndicatorProps {
  readonly holder: LockHolder;
  /** What the lock is on, in a few words that read after "Lock on": the page's ("this intake"). Never an identifier. */
  readonly subject?: string;
  /** Who it is, in the page's words ("Another receiver"): never a name the page does not have. Drawn for `other`. */
  readonly who?: string;
  /** When the holder last showed it was there, as the page wants it told ("09:12"). Drawn for `yours` and `other`. */
  readonly since?: string;
  /** One line that says what the lock does and does not do. The page words it: the component says nothing about a policy. */
  readonly note?: ReactNode;
  /** What the person can do about it ("Ask again"): the page's own control, drawn after the words. */
  readonly action?: ReactNode;
}

function sentenceOf({ holder, subject, who }: LockIndicatorProps): string {
  const on = subject === undefined ? '' : ` on ${subject}`;
  switch (holder) {
    case 'free':
      return `Nobody holds the lock${on}.`;
    case 'yours':
      return `You hold the lock${on}.`;
    case 'other':
      return `${who ?? 'Someone else'} holds the lock${on}.`;
    case 'unknown':
      return `Who holds the lock${on} is not known.`;
  }
}

const LABELS: Readonly<Record<LockHolder, string>> = {
  free: 'Not held',
  yours: 'Held by you',
  other: 'Held by someone else',
  unknown: 'Not known',
};

/**
 * The receiver-lock indicator (COMPONENT_PATTERNS, *LockIndicator*): a short statement of who holds an advisory lock, with the words doing the saying (the icon and the tone support them) and one line
 * from the page that says what the lock is not. Who holds it is a `status` region, so a change of holder is said to assistive technology once, politely (the moment of the last refresh is not, or it would be read out every minute), and it holds no control of its own: what a person can do
 * about it is the page's `action`.
 */
export function LockIndicator(props: LockIndicatorProps) {
  const { holder, since, note, action } = props;
  return (
    <div className={`ui-lock-indicator ui-lock-indicator--${holder}`}>
      <Icon name={holder === 'free' ? 'lock-open' : 'lock'} className="ui-lock-indicator__icon" />
      <div className="ui-lock-indicator__body">
        {/* Only who holds the lock is said aloud when it changes: the moment of the holder's last refresh changes every minute and is outside the live region, so that it is never announced. */}
        <div role="status">
          <p className="ui-lock-indicator__state">{LABELS[holder]}</p>
          <p className="ui-lock-indicator__text">{sentenceOf(props)}</p>
        </div>
        {since === undefined || (holder !== 'yours' && holder !== 'other') ? null : (
          <p className="ui-lock-indicator__text">Last active {since}.</p>
        )}
        {note === undefined ? null : <p className="ui-lock-indicator__note">{note}</p>}
        {action === undefined ? null : <div className="ui-lock-indicator__action">{action}</div>}
      </div>
    </div>
  );
}
