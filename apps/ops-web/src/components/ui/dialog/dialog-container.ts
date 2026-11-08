import { createContext } from 'react';

/**
 * The modal `<dialog>` that a control is drawn in, or null outside one. A modal dialog is in the browser's top layer and the page behind
 * it is inert, so a popover that is drawn into the page's body (the date field's calendar) would open under the dialog, unseen and out of
 * reach: inside a dialog it is drawn into the dialog.
 */
export const DialogContainer = createContext<HTMLElement | null>(null);
