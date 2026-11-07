import type { ReactNode } from 'react';

import { PageHeading } from '../../PageHeading';
import { OperationalCode } from '../code/OperationalCode';
import './record-header.css';
import { StageTracker, type StageTrackerProps } from './StageTracker';

export interface RecordHeaderProps {
  /** The record's code, exactly as the server gave it. It is the record's name: the page's one level-one heading, or a level-two heading in a panel. */
  readonly code: string;
  /** `1` for a record's own page (the heading takes focus after a navigation); `2` when the header is in a panel or beside a list. Default 1. */
  readonly level?: 1 | 2;
  /** The record's status as a badge, drawn beside the code. A slot: the page passes the StatusBadge of its mapping. */
  readonly status?: ReactNode;
  /** One sentence in plain words of where the record stands and what can be done next, or what stands in the way and why. */
  readonly sentence?: string;
  /** Where the record is on its way. Left out for a record that has no such way. */
  readonly stages?: StageTrackerProps;
  /** The record's one primary action, in Ink (a Button). One only: it is what the person does next. */
  readonly primaryAction?: ReactNode;
  /** Other actions that are not the main one (Buttons, `secondary`). */
  readonly secondaryActions?: ReactNode;
  /** The overflow menu of the rarer and heavier acts: an ActionMenu. */
  readonly menu?: ReactNode;
}

/**
 * The top of a record (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *RecordHeader and StageTracker*): its code in the monospaced face at 26/32, its
 * status, one sentence, the stage tracker, one primary action in Ink, the other actions, and the menu. It says where the record stands and what can be done next;
 * an act the person cannot take is not passed in (hiding is presentation, and the server decides). It composes `PageHeading` for a record's own page, so that
 * the focus move after a navigation keeps working.
 */
export function RecordHeader({
  code,
  level = 1,
  status,
  sentence,
  stages,
  primaryAction,
  secondaryActions,
  menu,
}: RecordHeaderProps) {
  const hasActions =
    primaryAction !== undefined || secondaryActions !== undefined || menu !== undefined;
  return (
    <div className="ui-record-header">
      <div className="ui-record-header__row">
        <div className="ui-record-header__identity">
          <div className="ui-record-header__titleline">
            {level === 1 ? (
              <PageHeading>
                <OperationalCode>{code}</OperationalCode>
              </PageHeading>
            ) : (
              <h2 className="ui-record-header__heading" tabIndex={-1}>
                <OperationalCode>{code}</OperationalCode>
              </h2>
            )}
            {status === undefined ? null : (
              <span className="ui-record-header__status">{status}</span>
            )}
          </div>
          {sentence === undefined ? null : <p className="ui-record-header__sentence">{sentence}</p>}
        </div>
        {hasActions ? (
          <div className="ui-record-header__actions">
            {secondaryActions}
            {primaryAction}
            {menu}
          </div>
        ) : null}
      </div>
      {stages === undefined ? null : (
        <div className="ui-record-header__stages">
          <StageTracker {...stages} />
        </div>
      )}
    </div>
  );
}
