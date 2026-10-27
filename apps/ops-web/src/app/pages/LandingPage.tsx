import { PageHeading } from '../../components/PageHeading';
import { Alert } from '../../components/ui/alert/Alert';
import { ButtonLink } from '../../components/ui/button/ButtonLink';
import { Icon } from '../../components/ui/icon/Icon';
import { Link } from '../../components/ui/link/Link';
import { ReadState } from '../../components/ui/read-state/ReadState';
import type { StaffIdentityPageView } from '../../platform/staff/staff-shape';
import { useStaffList } from '../../platform/staff/use-staff-queries';
import { useSignedInSession } from '../../platform/session/use-permissions';
import { destinationsFor } from '../navigation/route-registry';
import './LandingPage.css';

/** What is waiting for the person to decide, said for the number the first page of the queue holds. */
function waitingText(count: number, more: boolean): string {
  if (more) return `${String(count)} or more profiles are waiting for your approval.`;
  return count === 1
    ? '1 profile is waiting for your approval.'
    : `${String(count)} profiles are waiting for your approval.`;
}

/**
 * What is waiting for a person who works the approval queue. It is read only for a session that lists the keys to read staff and to decide
 * on a profile, and until it has been read nothing is said about it: "nothing is waiting" before the answer would send an approver away
 * from the queue, and a read that failed says so and is not taken for an empty queue. The server decides what the session may see.
 */
function Waiting() {
  const queue = useStaffList({ status: 'PENDING_APPROVAL' });
  return (
    <ReadState<StaffIdentityPageView>
      query={queue}
      isEmpty={(data) => data.items.length === 0}
      empty={<Alert variant="success">Nothing is waiting.</Alert>}
      loadingLabel="Checking what is waiting…"
      permission="staff.read"
      operation="listStaffIdentities"
    >
      {(data) => (
        <div className="landing-waiting">
          <p className="landing-waiting__text">
            {waitingText(data.items.length, data.nextPageToken !== null)}
          </p>
          <ButtonLink to="/admin/staff?view=waiting">Review the queue</ButtonLink>
        </div>
      )}
    </ReadState>
  );
}

/**
 * The signed-in landing (surfaces/ops-portal.md section 7, `/`): who is signed in, what is waiting for them, the hubs the session acts in,
 * and the places it may go. Nothing waiting is a success message and not a blank. It shows only what `getCurrentSession` said and what the
 * session's keys allow; later slices fill the landing, they do not replace it. The navigation and the sign-out control that every signed-in
 * screen carries are the authenticated Ops shell's, drawn around this page (`AuthenticatedOpsShell`).
 */
export function LandingPage() {
  const me = useSignedInSession();
  // The route sits under the session guard, which renders this only for a signed-in session.
  if (me === undefined) return null;
  const { principal_display_name: name, authorized_hubs: hubs, permissions } = me.session;
  const works = me.holds('staff.read') && me.holds('staff.identity.approve');
  const destinations = destinationsFor(permissions);

  return (
    <>
      <title>Melarc Ops Portal</title>
      <PageHeading>Melarc Ops Portal</PageHeading>
      <p>
        {name === null ? (
          'You are signed in.'
        ) : (
          <>
            Signed in as <strong>{name}</strong>.
          </>
        )}
      </p>

      <h2 id="landing-waiting">Waiting for you</h2>
      {works ? <Waiting /> : <Alert variant="success">Nothing is waiting.</Alert>}

      <h2 id="landing-hubs">Your hubs</h2>
      {hubs.length === 0 ? (
        <p>No hub is listed for your session.</p>
      ) : (
        <ul aria-labelledby="landing-hubs">
          {hubs.map((hub) => (
            <li key={hub.id}>{hub.display_name}</li>
          ))}
        </ul>
      )}

      {destinations.length === 0 ? null : (
        <>
          <h2 id="landing-places">Where to go</h2>
          <ul className="landing-places" aria-labelledby="landing-places">
            {destinations.map((place) => (
              <li key={place.to}>
                <Link to={place.to}>
                  {/* The picture the menu gives the same place: one meaning, one icon (DESIGN_SYSTEM section 24). */}
                  <Icon name={place.icon} size="sm" className="landing-places__icon" />
                  {place.label}
                </Link>
                {place.description === undefined ? null : (
                  <span className="landing-places__description"> {place.description}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
