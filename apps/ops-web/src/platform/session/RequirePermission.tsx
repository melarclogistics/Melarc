import type { ReactNode } from 'react';

import { ForbiddenPage } from '../../components/ui/forbidden-state/ForbiddenState';
import { useSession } from './session-context';

/**
 * A page that needs a permission key. A session that holds it sees the page; a signed-in session that does not sees a
 * refusal that names the key, never a role (surfaces/ops-portal.md section 7), and the page itself is not rendered at
 * all. This is the screen's half of the rule: hiding a link is not enforcement, and the server still checks the key on
 * every request. While the session is not known, or nobody is signed in, it shows nothing: the session guard above it
 * decides those, and this one does not guess. The refusal is the forbidden state (`ForbiddenPage`), which names the key.
 */
export function RequirePermission({
  permission,
  children,
}: {
  readonly permission: string;
  readonly children: ReactNode;
}) {
  const state = useSession();
  if (state.status !== 'signed-in') return null;
  if (state.session.permissions?.includes(permission) === true) return children;
  return <ForbiddenPage kind="permission-missing" permission={permission} />;
}
