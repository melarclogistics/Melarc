import './icon.css';
import { ICONS, type IconName } from './icons';

export type IconSize = 'sm' | 'md' | 'lg';

export interface IconProps {
  readonly name: IconName;
  /** 1rem, 1.25rem or 1.5rem (`--icon-size-*`): in rem, so that enlarged text enlarges the icon with it. Default `md`. */
  readonly size?: IconSize;
  /**
   * What the icon says, when it is the only thing that says it. Leave it out (the usual case) when words beside it already say it:
   * the icon is then decorative and hidden from assistive technology, so nothing is announced twice (DESIGN_SYSTEM section 24).
   */
  readonly label?: string;
  readonly className?: string;
}

/** Every icon is drawn with this stroke, at every size, so that no two icons of the application differ in weight. */
export const ICON_STROKE_WIDTH = 2;

/**
 * An icon of the Ops Portal's one family (COMPONENT_PATTERNS section 22; DESIGN_SYSTEM section 24). It takes its colour from the text it
 * sits in (`currentColor`), so it is as legible as that text is, and its size from a token. An icon that repeats adjacent text is
 * decorative; one that stands alone either has a `label` here or sits in a control that is named (`IconButton`).
 */
export function Icon({ name, size = 'md', label, className }: IconProps) {
  const Glyph = ICONS[name];
  const classes = ['ui-icon', `ui-icon--${size}`, className].filter(Boolean).join(' ');
  return label === undefined ? (
    <Glyph
      className={classes}
      strokeWidth={ICON_STROKE_WIDTH}
      aria-hidden="true"
      focusable="false"
    />
  ) : (
    <Glyph
      className={classes}
      strokeWidth={ICON_STROKE_WIDTH}
      role="img"
      aria-label={label}
      focusable="false"
    />
  );
}
