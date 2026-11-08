import { useContext, useEffect } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router';

import { AlertDialog } from '../dialog/AlertDialog';

/** The question a person is asked when they would leave a form that holds what they typed. */
const LEAVE_TITLE = 'Leave this page?';
const LEAVE_WORDS =
  'What you entered on this page has not been saved, and it is lost if you leave.';

/** Asks before the application's own navigation takes the person away: it needs the application's router, so it is drawn only where there is one. */
function NavigationBlock({ when }: { readonly when: boolean }) {
  const blocker = useBlocker(when);
  return (
    <AlertDialog
      open={blocker.state === 'blocked'}
      title={LEAVE_TITLE}
      confirmLabel="Leave the page"
      cancelLabel="Stay here"
      onConfirm={() => {
        blocker.proceed?.();
      }}
      onCancel={() => {
        blocker.reset?.();
      }}
    >
      {LEAVE_WORDS}
    </AlertDialog>
  );
}

/**
 * A guard against leaving a form with unsaved changes (PRODUCT_DESIGN_DIRECTION section 6.3; COMPONENT_PATTERNS, *TaskForm*). While `when` is true it asks before the application's
 * navigation (a link, the browser's Back) takes the person away, with a question whose safe answer is "Stay here" and has focus first, and it sets the browser's own warning for
 * a reload or a closed tab. It holds nothing and decides nothing about what is unsaved: the page says `when`. A form that was sent is not unsaved, so the page turns it off.
 */
export function UnsavedChangesGuard({ when }: { readonly when: boolean }) {
  // The router of the application is a data router; a page drawn without one (a test, the showcase) has nothing to block, and the browser's warning still holds.
  const router = useContext(UNSAFE_DataRouterContext);
  useEffect(() => {
    if (!when) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [when]);
  return router === null ? null : <NavigationBlock when={when} />;
}
