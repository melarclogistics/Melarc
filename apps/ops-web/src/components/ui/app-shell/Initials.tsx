import { Icon } from '../icon/Icon';
import { initialsOf } from './initials-of';

/**
 * A person's initials in a tile: up to two letters, or the account icon for a person with no letter in their name. A tile with a radius of the
 * controls and not a circle (redesign step R4: `radius.md` for the sidebar's entries, the avatar and the mark). It is decoration: the name it stands
 * for is always written beside it or on the control that holds it, so it is hidden from assistive technology.
 */
export function Initials({
  name,
  className,
}: {
  readonly name: string | null;
  readonly className: string;
}) {
  const initials = initialsOf(name);
  return (
    <span className={className} aria-hidden="true">
      {initials === '' ? <Icon name="account" /> : initials}
    </span>
  );
}
