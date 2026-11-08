import art1 from '../../../assets/auth/auth-art-1.webp?no-inline';
import art2 from '../../../assets/auth/auth-art-2.webp?no-inline';
import art3 from '../../../assets/auth/auth-art-3.webp?no-inline';
import art4 from '../../../assets/auth/auth-art-4.webp?no-inline';

/**
 * Which photograph the split screen shows beside each of the seven pre-sign-in screens (the two recovery screens since S0.52a). The four photographs are the Product Owner's
 * (`design/images`, supplied on 25 October 2026) in web-sized copies (`src/assets/auth/README.md` records the source, checksum and settings of
 * each). Reassigning a screen to another photograph is a change to this one table; a screen that is not in it (a path the router sent here that
 * this table does not name) is shown no photograph and the panel is the brand on Ink alone, never a stand-in picture.
 *
 * The photographs are decorative (empty alternative text, hidden from assistive technology): the screen's own words say everything the
 * photograph does not.
 */
export const AUTH_ART: Readonly<Record<string, string>> = {
  // The rider reading their phone and holding a parcel: where a person starts.
  '/sign-in': art1,
  // The courier at the door with a thumb up: the second step, the check that it is them.
  '/sign-in/mfa': art2,
  // The welcome: a person receiving what was brought to them, for the person setting a first password.
  '/setup/credential': art3,
  // The phone in hand again: the authenticator app is the thing being set up.
  '/setup/mfa': art1,
  // Done.
  '/setup/mfa/complete': art4,
  // The phone in hand: a person starting again from the address they hold (S0.52a).
  '/recovery': art1,
  // The welcome again: a person given back what was theirs, for the person setting a new password.
  '/recovery/complete': art3,
};

/** The photograph for an address, or nothing. A trailing slash is the same address. */
export function artFor(pathname: string): string | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return Object.hasOwn(AUTH_ART, path) ? AUTH_ART[path] : undefined;
}
