import { useContext, type ReactNode } from 'react';

import { ActionMenu, type ActionMenuItem } from '../action-menu/ActionMenu';
import { Alert } from '../alert/Alert';
import { Button } from '../button/Button';
import { BreadcrumbTrail, type BreadcrumbEntry } from '../page-header/BreadcrumbTrail';
import { Panel } from '../panel/Panel';
import { RecordHeader, type RecordHeaderProps } from '../record-header/RecordHeader';
import { StageTracker } from '../record-header/StageTracker';
import { InSidePanel } from '../side-panel/side-panel-context';
import { Timeline, type TimelineEntry } from '../timeline/Timeline';
import './record-page.css';

/**
 * The acts of the record. **Only an act the session can take is passed in**: hiding is presentation and never enforcement, and the server refuses what is not allowed
 * (PRODUCT_DESIGN_DIRECTION section 6.2). The primary action is the one thing to do next, in Ink; the others do not compete with it, and the heavier ones are in the menu, with
 * the destructive ones last and always confirmed (`ActionMenu`).
 */
export interface RecordActs {
  /** The record's one primary action: a Button. One only. */
  readonly primary?: ReactNode;
  /** Other acts that are not the main one: Buttons, `secondary`. */
  readonly secondary?: ReactNode;
  /** The rarer and heavier acts. A menu with no item is not drawn. */
  readonly menu?: { readonly label: string; readonly items: readonly ActionMenuItem[] };
  /**
   * One short line under the acts, only when it changes whether to act now ("The rider sees nothing until you dispatch."). A rule lives in the confirmation of the act, where the
   * choice is made; a paragraph of rules above the content is not drawn (the Product Owner, 9 November 2026).
   */
  readonly note?: string;
}

/** A version of the record that is not the server's now (a stale `ETag`): the screen says so and offers to read it again. */
export interface RecordConflict {
  /** Default "This record changed since you opened it. Reload to see the latest version." Say it in the record's own words where that helps. */
  readonly message?: string;
  readonly onReload: () => void;
}

export interface RecordActivity {
  /** Names the list for assistive technology and heads the panel. Default "Activity". */
  readonly title?: string;
  /** What happened, oldest first. The page marks the latest `current` (a filled marker; the order says it is the latest). */
  readonly entries: readonly TimelineEntry[];
  /** Words for the current step, in a tag after its title. None by default: a history in order does not need "Latest". */
  readonly currentLabel?: string;
}

export interface RecordPageProps {
  /** The pages above this one. Not drawn inside a panel. */
  readonly breadcrumb?: readonly BreadcrumbEntry[];
  /** Who the record is and where it stands: its code (the page's one level-one heading), its status as a badge, one plain-words sentence, and the stages. */
  readonly header: Pick<RecordHeaderProps, 'code' | 'status' | 'sentence' | 'stages'>;
  readonly acts?: RecordActs;
  readonly conflict?: RecordConflict;
  /** Banners and notices that belong to the whole record, between the header and the body. */
  readonly notice?: ReactNode;
  /** The work: the record's own panels, in the order the officer reads them. Compose `Panel`s (heading level 2 on a page, 3 in a side panel). */
  readonly main: ReactNode;
  /** Facts, people and related records, in the side column. On a narrow screen and inside a panel it follows the work. */
  readonly side?: ReactNode;
  readonly activity?: RecordActivity;
}

/** The acts of a record in a side panel: the primary first, then the others, then the menu (as the header draws them). */
function Acts({ acts }: { readonly acts: RecordActs }) {
  return (
    <>
      {acts.primary}
      {acts.secondary}
      {acts.menu === undefined || acts.menu.items.length === 0 ? null : (
        <ActionMenu label={acts.menu.label} items={acts.menu.items} />
      )}
    </>
  );
}

function Conflict({ conflict }: { readonly conflict: RecordConflict }) {
  return (
    <Alert
      variant="danger"
      announce
      action={
        <Button type="button" variant="secondary" onClick={conflict.onReload}>
          Reload
        </Button>
      }
    >
      {conflict.message ??
        'This record changed since you opened it. Reload to see the latest version.'}
    </Alert>
  );
}

/**
 * The record page template (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *RecordPage*): one thing and its history. It composes the kit into the shape of a record: a header
 * (the code, the status, one sentence of where the record stands and what is next, the stages, **one** primary action, the others and a menu), a main column for the work, a side
 * column for facts, people and related records, and an activity timeline. A stale version is a banner with *Reload*; an act the session cannot take is not passed in and so is not
 * drawn. **The same composition renders in a `SidePanel`**: there the panel's own heading is the code, the breadcrumb and the page card go, the header keeps the sentence, the stages
 * and the acts, and the columns become one. It owns the structure and shows what it is given: the facts, the words and the acts are the page's, and the server decides.
 */
export function RecordPage({
  breadcrumb,
  header,
  acts,
  conflict,
  notice,
  main,
  side,
  activity,
}: RecordPageProps) {
  const inPanel = useContext(InSidePanel);
  const timeline =
    activity === undefined ? null : (
      <Panel title={activity.title ?? 'Activity'} headingLevel={inPanel ? 3 : 2}>
        <Timeline
          label={`${activity.title ?? 'Activity'} of the record`}
          entries={activity.entries}
          currentLabel={activity.currentLabel}
        />
      </Panel>
    );

  if (inPanel) {
    return (
      <div className="ui-record-page" data-in-panel="">
        {conflict === undefined ? null : <Conflict conflict={conflict} />}
        <div className="ui-record-page__lead">
          {header.sentence === undefined ? null : (
            <p className="ui-record-page__sentence">{header.sentence}</p>
          )}
          {header.stages === undefined ? null : <StageTracker {...header.stages} />}
          {acts === undefined ? null : (
            <div className="ui-record-page__acts">
              <Acts acts={acts} />
            </div>
          )}
          {acts?.note === undefined ? null : <p className="ui-record-page__note">{acts.note}</p>}
        </div>
        {notice}
        {main}
        {timeline}
        {side}
      </div>
    );
  }

  return (
    <div className="ui-record-page">
      {conflict === undefined ? null : <Conflict conflict={conflict} />}
      {breadcrumb === undefined ? null : <BreadcrumbTrail breadcrumb={breadcrumb} />}
      <Panel variant="page">
        <RecordHeader
          code={header.code}
          {...(header.status === undefined ? {} : { status: header.status })}
          {...(header.sentence === undefined ? {} : { sentence: header.sentence })}
          {...(header.stages === undefined ? {} : { stages: header.stages })}
          {...(acts?.primary === undefined ? {} : { primaryAction: acts.primary })}
          {...(acts?.secondary === undefined ? {} : { secondaryActions: acts.secondary })}
          {...(acts?.note === undefined ? {} : { actionsNote: acts.note })}
          {...(acts?.menu === undefined || acts.menu.items.length === 0
            ? {}
            : { menu: <ActionMenu label={acts.menu.label} items={acts.menu.items} /> })}
        />
      </Panel>
      {notice}
      <div className="ui-record-page__columns" data-side={side === undefined ? undefined : ''}>
        <div className="ui-record-page__main">
          {main}
          {timeline}
        </div>
        {side === undefined ? null : <div className="ui-record-page__side">{side}</div>}
      </div>
    </div>
  );
}
