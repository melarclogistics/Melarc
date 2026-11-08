import { groupedKey } from '../../../platform/secrets/otpauth';
import { Field } from '../field/Field';
import { Input } from '../input/Input';

export interface OneTimeSecretProps {
  /** What it is, for the person: "Setup key". */
  readonly label: string;
  /** The secret to show. The component keeps no copy: it shows what it is given while it is given it. */
  readonly secret: string;
  /** How to use it. Not for the secret itself. */
  readonly help?: string;
  /** Characters to a group; `0` shows the secret as one run. */
  readonly groupSize?: number;
}

/**
 * A secret shown once, for a person to read and type by hand (COMPONENT_PATTERNS section 6; the manual-entry key of
 * `/setup/mfa`, which stays as the accessible alternative to the QR code). It is a read-only field, so it is reachable
 * by keyboard, selectable, and named by its label.
 *
 * What it does not do is the point of it. It has no `name`, so a form around it never submits it; it asks the browser
 * not to remember or complete it; it has no copy button, because the system clipboard is kept by clipboard history and
 * read by other programs; it is no link and writes it to no attribute. Its owner holds the secret with
 * `useTransientSecret` and stops rendering this when the secret is gone, which takes it off the screen.
 */
export function OneTimeSecret({ label, secret, help, groupSize = 4 }: OneTimeSecretProps) {
  return (
    <Field label={label} {...(help === undefined ? {} : { help })}>
      <Input
        readOnly
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={groupSize > 0 ? groupedKey(secret, groupSize) : secret}
      />
    </Field>
  );
}
