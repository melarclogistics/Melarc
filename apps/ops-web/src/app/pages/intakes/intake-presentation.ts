import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import type {
  CountVariance,
  IntakeCondition,
  IntakeState,
} from '../../../platform/hub-intake/hub-intake-shape';

/**
 * What each state, comparison and condition of an intake is called **where the portal lists them in a generic table of statuses** (`src/app/status/status-table.ts`, held to the contract's enumerations): the
 * words of the receiving screens themselves are `RECEIVING_WORDS` (`platform/problem/receiving-copy.ts`), in the floor's voice. Every mapping is typed over its whole enumeration, so a value the contract adds is
 * a compile error here until someone decides how it reads. A state is told by its words, and the tone supports them and never carries them. **Nothing here works out a count, a difference or a state.**
 */

/** What each state of an intake is called. */
export const INTAKE_STATE_MAP: StatusMap<IntakeState> = {
  AWAITING_COUNT: { tone: 'warning', label: 'Awaiting count' },
  COUNTED: { tone: 'info', label: 'Counted' },
  RECONCILIATION_REQUIRED: { tone: 'warning', label: 'Needs a decision' },
  READY_FOR_ITEMIZATION: { tone: 'success', label: 'Ready to itemise' },
  ITEMIZING: { tone: 'info', label: 'Being itemised' },
  CLOSED: { tone: 'neutral', label: 'Closed' },
};

/** The API's comparison of the count with the declaration, as a state in words. */
export const VARIANCE_MAP: StatusMap<CountVariance> = {
  MATCH: { tone: 'success', label: 'Matches' },
  SHORT: { tone: 'warning', label: 'Short' },
  OVER: { tone: 'warning', label: 'Over' },
};

/** What the receiver found: independent of the count, and never collapsed with it. */
export const CONDITION_MAP: StatusMap<IntakeCondition> = {
  OK: { tone: 'success', label: 'Good condition' },
  DAMAGED: { tone: 'danger', label: 'Damaged' },
  TAMPERED: { tone: 'danger', label: 'Tampered with' },
  OTHER: { tone: 'warning', label: 'Another problem' },
};
