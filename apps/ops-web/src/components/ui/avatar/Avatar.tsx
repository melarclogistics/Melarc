import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '../../primitives/avatar';
import { initialsOf } from '../app-shell/initials-of';
import { Icon } from '../icon/Icon';
import './avatar.css';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** Whose it is. The initials are the first letter of the first and of the last word of the name; a name with no letter, or none, draws the account icon. */
  readonly name: string | null;
  /** A picture of the person, when there is one. It is drawn once it has loaded, and until then (and if it never loads) the initials stand. */
  readonly src?: string;
  /** 24px, 32px or 40px. */
  readonly size?: AvatarSize;
  /**
   * Set when the avatar stands on its own, with no name written beside it: it is then a picture named by the person's name. Left off (the usual case, in a list or a
   * menu where the name is written next to it) it is decoration, hidden from assistive technology, so that the name is not read twice.
   */
  readonly alone?: boolean;
}

const PRIMITIVE_SIZE = { sm: 'sm', md: 'default', lg: 'lg' } as const;

/**
 * A person's avatar (COMPONENT_PATTERNS, *Avatar*; the second half of redesign step R5): a tile with the radius of the controls (`radius.md`, as the sidebar's entries and the
 * mark have it, and not a circle), drawn by the avatar primitive. The fallback, which is the usual case, is the initials in `text.secondary` on `surface.selected`: the
 * pair that reads (6.38:1 in the light theme) where the muted text does not. A picture is never required, and never the only thing: a name that has not loaded one is
 * still someone.
 */
export function Avatar({ name, src, size = 'md', alone = false }: AvatarProps) {
  const initials = initialsOf(name);
  return (
    <AvatarRoot
      size={PRIMITIVE_SIZE[size]}
      className="ui-avatar"
      data-ui-size={size}
      {...(alone
        ? { role: 'img', 'aria-label': name === null || name === '' ? 'Unknown person' : name }
        : { 'aria-hidden': true })}
    >
      {src === undefined ? null : <AvatarImage src={src} alt="" />}
      <AvatarFallback className="ui-avatar__fallback">
        {initials === '' ? <Icon name="account" /> : initials}
      </AvatarFallback>
    </AvatarRoot>
  );
}
