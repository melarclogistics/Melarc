import { useCallback, useSyncExternalStore } from 'react';

import {
  currentThemeChoice,
  saveThemeChoice,
  subscribeThemeChoice,
  type ThemeChoice,
} from './theme-choice';

/**
 * The person's choice of theme (`system`, `light` or `dark`) and the way to change it, kept up to date when the choice changes anywhere: this
 * tab's menus, another tab, or the root's attribute. The component that draws a control reads this; the module that keeps the choice in the
 * browser (`theme-choice.ts`) is the only one that touches storage.
 */
export function useThemeChoice(): readonly [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore(
    subscribeThemeChoice,
    currentThemeChoice,
    (): ThemeChoice => 'system',
  );
  const choose = useCallback((next: ThemeChoice): void => {
    saveThemeChoice(next);
  }, []);
  return [choice, choose];
}
