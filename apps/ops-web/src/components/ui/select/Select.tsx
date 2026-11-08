import type { ComponentPropsWithoutRef } from 'react';

import { useFieldControl } from '../field/Field';
import './select.css';

export type SelectProps = Omit<
  ComponentPropsWithoutRef<'select'>,
  'className' | 'style' | 'size' | 'multiple'
>;

/**
 * The Select (COMPONENT_PATTERNS section 7.9): a native single-choice `<select>` at medium size, wired to a Field exactly as an Input is. The
 * options are the caller's `<option>` children, so the control keeps everything the browser gives it: the picker of each platform, the
 * keyboard, type-ahead and the accessible role. It offers one choice; a list that takes several is another control and is not built.
 */
export function Select({
  id,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  ...rest
}: SelectProps) {
  const field = useFieldControl();
  const description = [describedBy, field?.describedBy]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
  return (
    <select
      {...rest}
      // Inside a Field the Field owns the id, because its label points at it; a caller's id would orphan the label.
      id={field?.id ?? id}
      className="ui-select"
      aria-describedby={description === '' ? undefined : description}
      aria-invalid={field?.invalid === true ? true : ariaInvalid}
      aria-required={field?.required === true ? true : ariaRequired}
    />
  );
}
