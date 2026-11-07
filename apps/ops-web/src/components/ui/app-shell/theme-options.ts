import type { IconName } from '../icon/icons';

/** The three choices of theme, as a menu offers them (the same as the platform's `ThemeChoice`, which is what keeps it). */
export type ThemeValue = 'system' | 'light' | 'dark';

/** What each choice is called and drawn as: System follows the operating system; Light and Dark are the person's own. */
export const THEME_OPTIONS: readonly {
  readonly value: ThemeValue;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { value: 'system', label: 'System', icon: 'theme-system' },
  { value: 'light', label: 'Light', icon: 'theme-light' },
  { value: 'dark', label: 'Dark', icon: 'theme-dark' },
];

/** Whether a string is one of the three, so that a menu's radio value is never taken for a theme it is not. */
export const isThemeValue = (value: string): value is ThemeValue =>
  THEME_OPTIONS.some((option) => option.value === value);
