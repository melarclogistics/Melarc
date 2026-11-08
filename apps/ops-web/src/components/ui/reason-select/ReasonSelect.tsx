import type { ReasonChoice } from '../../../platform/reasons/reason-definitions';
import { Alert } from '../alert/Alert';
import { Field } from '../field/Field';
import { ReadState, type ReadQuery } from '../read-state/ReadState';
import { Select } from '../select/Select';

export interface ReasonSelectProps {
  /** The reasons of the action, read from `listReasonDefinitions` (`useReasonDefinitions`). The picker holds no list of its own. */
  readonly query: ReadQuery<ReasonChoice[]>;
  /** The code of the reason chosen, or an empty string for none. */
  readonly value: string;
  /** Says which reason was chosen, with the reason itself (so the form knows whether a note is mandatory), or none. */
  readonly onChange: (code: string, reason: ReasonChoice | undefined) => void;
  /** What is wrong with the choice, for the field to show. */
  readonly error?: string;
  /** The choice may not be changed now. */
  readonly disabled?: boolean;
}

/**
 * The picker of a reason (surfaces/ops-portal.md section 7: a reason is mandatory on the reset and session screens): a required field with
 * a select over the reasons the server offers for the action. The reasons are the server's and nothing else is offered; no reason code
 * is invented here and no second catalogue is kept. If the reasons cannot be had, the field is not drawn: it says why (loading, a
 * refusal that names `settings.reason.read`, a fault with a retry, or no reason at all), and the form that holds it cannot go on.
 */
export function ReasonSelect({
  query,
  value,
  onChange,
  error,
  disabled = false,
}: ReasonSelectProps) {
  return (
    <ReadState
      query={query}
      operation="listReasonDefinitions"
      permission="settings.reason.read"
      loadingLabel="Loading the reasons…"
      isEmpty={(reasons) => reasons.length === 0}
      empty={
        <Alert variant="danger">
          <p>No reason is available for this action, so it cannot be done now.</p>
        </Alert>
      }
    >
      {(reasons) => (
        <Field label="Reason" required {...(error === undefined ? {} : { error })}>
          <Select
            name="reason"
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const code = event.target.value;
              onChange(
                code,
                reasons.find((reason) => reason.code === code),
              );
            }}
          >
            <option value="">Choose a reason</option>
            {reasons.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </ReadState>
  );
}
