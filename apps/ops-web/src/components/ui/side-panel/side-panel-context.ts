import { createContext } from 'react';

/**
 * True inside a `SidePanel`. The panel's own heading is the record's code (it names the panel), so a `RecordHeader` drawn inside one draws its code as text and not as a second
 * heading with the same words (task R5.2, M12): the header reads this and takes the panel's heading in place of its own.
 */
export const InSidePanel = createContext(false);
