import { Navigate, useParams } from 'react-router';

import { recordPath } from './receiving-presentation';

/**
 * `/intakes/{id}/condition` was the page of the one condition of a whole vendor (S1.35). Damage is now recorded where it is seen: on a parcel's own photo on the run's page, and, for a vendor counted without
 * photos, in a dialog of its record. A link made before goes to the vendor's record, where that act is.
 */
export function ConditionRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={recordPath(id)} replace />;
}
