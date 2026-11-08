import type { ReactNode } from 'react';

import { PageHeading } from '../../PageHeading';
import { Alert } from '../alert/Alert';

/**
 * The refusals of authority, which are different bugs with different fixes (errors-and-enums.md section 4) and so are told differently:
 *
 * - `permission-missing`: the session does not hold the permission the page needs (`PERMISSION_DENIED`);
 * - `insufficient-authority`: it holds the key but this target or state needs a higher authority (`INSUFFICIENT_AUTHORITY`);
 * - `outside-hubs`: the record exists in a hub the session does not act in (`HUB_SCOPE_VIOLATION`);
 * - `approval-required`: a different approver, one who holds the permission, decides this (`SELF_APPROVAL_FORBIDDEN`);
 * - `unavailable-here`: the act is not available for this record in this state.
 */
export type ForbiddenKind =
  | 'permission-missing'
  | 'insufficient-authority'
  | 'outside-hubs'
  | 'approval-required'
  | 'unavailable-here';

export type ForbiddenStateProps =
  | {
      readonly kind: 'permission-missing';
      /** The permission key the page needs. The refusal names it, and never a role. */
      readonly permission: string;
      readonly announce?: boolean;
    }
  | {
      readonly kind: Exclude<ForbiddenKind, 'permission-missing'>;
      /** The permission key the refusal is about, when it is one a person can be told. */
      readonly permission?: string;
      readonly announce?: boolean;
    };

const HEADING: Readonly<Record<ForbiddenKind, string>> = {
  'permission-missing': 'You do not have access',
  'insufficient-authority': 'A higher authority is needed',
  'outside-hubs': 'This is outside your hubs',
  'approval-required': 'Approval is needed',
  'unavailable-here': 'This is not available here',
};

/** What the heading of a whole page says; it is the one level-one heading of the page, so it says the page. */
const PAGE_HEADING: Readonly<Record<ForbiddenKind, string>> = {
  ...HEADING,
  'permission-missing': 'You do not have access to this page',
};

function Key({ permission }: { readonly permission: string }) {
  return <code>{permission}</code>;
}

function Explanation({
  kind,
  permission,
}: {
  readonly kind: ForbiddenKind;
  readonly permission?: string;
}): ReactNode {
  switch (kind) {
    case 'permission-missing':
      return (
        <>
          This needs the permission <Key permission={permission ?? ''} />, which your session does
          not hold.
        </>
      );
    case 'insufficient-authority':
      return permission === undefined ? (
        'This needs a higher authority than your session has.'
      ) : (
        <>
          Your permission <Key permission={permission} /> does not reach this. It needs a higher
          authority than your session has.
        </>
      );
    case 'outside-hubs':
      return 'This record belongs to a hub your session does not act in.';
    case 'approval-required':
      return permission === undefined ? (
        'A different approver is required.'
      ) : (
        <>
          An approver who holds the permission <Key permission={permission} /> decides this.
        </>
      );
    case 'unavailable-here':
      return 'This cannot be done for this record as it stands.';
  }
}

/**
 * A refusal of authority, told in words (COMPONENT_PATTERNS section 15): which kind of refusal it is, and the permission key it is about,
 * never a role. It is an Alert in the page, for a part of a page that cannot be had (a reason list the session may not read); a whole page
 * that cannot be had is {@link ForbiddenPage}. Showing it is not enforcement: the server refuses again on every request.
 */
export function ForbiddenState(props: ForbiddenStateProps) {
  const { kind, announce = false } = props;
  return (
    <Alert variant="danger" title={HEADING[kind]} announce={announce}>
      <p>
        <Explanation
          kind={kind}
          {...(props.permission === undefined ? {} : { permission: props.permission })}
        />
      </p>
    </Alert>
  );
}

/**
 * A whole page that the session cannot have: its title, its one level-one heading, and the refusal. The guard of a route renders it
 * instead of the page, which is not rendered at all.
 */
export function ForbiddenPage(props: ForbiddenStateProps) {
  const { kind } = props;
  return (
    <>
      <title>No access · Melarc Ops Portal</title>
      <PageHeading>{PAGE_HEADING[kind]}</PageHeading>
      <Alert variant="danger">
        <p>
          <Explanation
            kind={kind}
            {...(props.permission === undefined ? {} : { permission: props.permission })}
          />
        </p>
      </Alert>
    </>
  );
}
