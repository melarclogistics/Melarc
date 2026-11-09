import { useContext, type ReactNode } from 'react';

import { PageHeading } from '../../PageHeading';
import { OperationalCode } from '../code/OperationalCode';
import { InSidePanel } from '../side-panel/side-panel-context';
import './record-header.css';
import { StageTracker, type StageTrackerProps } from './StageTracker';

export interface RecordHeaderProps {
  /**
   * The record's code, exactly as the server gave it. It is the record's name: the page's one level-one heading, or a level-two heading beside a list. **Inside a `SidePanel`
   * it is drawn as text**: the panel's own heading is the same code, and two headings with one name would be read twice (task R5.2, M12).
   */
  readonly code: string;
  /** `1` for a record's own page (the heading takes focus after a navigation); `2` when the header is in a panel or beside a list. Default 1. */
  readonly level?: 1 | 2;
  /** The record's status as a badge, drawn beside the code. A slot: the page passes the StatusBadge of its mapping. */
  readonly status?: ReactNode;
  /** One sentence in plain words of where the record stands and what can be done next, or what stands in the way and why. */
  readonly sentence?: string;
  /** Where the record is on its way. Left out for a record that has no such way. */
  readonly stages?: StageTrackerProps;
  /** The record's one primary action, in Ink (a Button). One only: it is what the person does next. It comes first: on a narrow screen the actions wrap under the identity, and a keyboard meets it first. */
  readonly primaryAction?: ReactNode;
  /** Other actions that are not the main one (Buttons, `secondary`). They follow the primary action. */
  readonly secondaryActions?: ReactNode;
  /** The overflow menu of the rarer and heavier acts: an ActionMenu. It comes last. */
  readonly menu?: ReactNode;
  /**
   * One short line under the actions, only when it changes whether to act now ("The rider sees nothing until you dispatch."). A rule belongs in the confirmation
   * of the act, where the choice is made; this is not the place for one (the Product Owner, 9 November 2026).
   */
  readonly actionsNote?: string;
}

/**
 * The top of a record (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *RecordHeader and StageTracker*): its code in the monospaced face at 26/32, its
 * status, one sentence, the stage tracker, one primary action in Ink, the other actions, and the menu, in that order (the primary first), with at most one short line
 * under the actions. It says where the record stands and what can be done next;
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
  actionsNote,
}: RecordHeaderProps) {
  const inPanel = useContext(InSidePanel);
  const hasActions =
    primaryAction !== undefined || secondaryActions !== undefined || menu !== undefined;
  return (
    <div className="ui-record-header">
      <div className="ui-record-header__row">
        <div className="ui-record-header__identity">
          <div className="ui-record-header__titleline">
            {inPanel ? (
              <p className="ui-record-header__heading">
                <OperationalCode>{code}</OperationalCode>
              </p>
            ) : level === 1 ? (
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
        {hasActions || actionsNote !== undefined ? (
          <div className="ui-record-header__acts">
            {hasActions ? (
              <div className="ui-record-header__actions">
                {primaryAction}
                {secondaryActions}
                {menu}
              </div>
            ) : null}
            {actionsNote === undefined ? null : (
              <p className="ui-record-header__note">{actionsNote}</p>
            )}
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
