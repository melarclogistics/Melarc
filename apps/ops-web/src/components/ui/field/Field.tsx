import { createContext, useContext, useId, type ReactNode } from 'react';

import { Icon } from '../icon/Icon';
import './field.css';

/** What a control inside a Field needs in order to be tied to its label, help and error. */
export interface FieldControl {
  readonly id: string;
  /** The ids of the help and error text that exist, space separated, or undefined when there are none. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
}

const FieldContext = createContext<FieldControl | null>(null);

/** The wiring of the enclosing Field, or null for a control that stands on its own. */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  /** Short, specific, sentence case. A placeholder never replaces it (COMPONENT_PATTERNS section 6.3). */
  readonly label: string;
  /** Format expectations and context. Not for errors. */
  readonly help?: string;
  /** What is wrong and how to correct it. Its presence makes the control invalid. */
  readonly error?: string;
  readonly required?: boolean;
  /** The control, such as an Input. */
  readonly children: ReactNode;
}

const present = (text: string | undefined): text is string => text !== undefined && text !== '';

/**
 * The composition that ties a label, a control, optional help and an optional error together
 * (COMPONENT_PATTERNS section 6). It is not a form engine: it holds no value and does no validation. The label is a real
 * `<label>`, help and error are linked with `aria-describedby`, and an error makes the control `aria-invalid`. The error is
 * text with an icon, and is not a live region: the form moves focus to the first invalid field, which reads it once.
 */
export function Field({ label, help, error, required = false, children }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const hasHelp = present(help);
  const hasError = present(error);
  const describedBy = [hasHelp ? helpId : undefined, hasError ? errorId : undefined]
    .filter((part) => part !== undefined)
    .join(' ');

  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
        {required ? (
          <>
            {/* A text node of its own: a space inside the span is dropped from the accessible name. */}{' '}
            <span className="ui-field__required">(required)</span>
          </>
        ) : null}
      </label>
      <FieldContext
        value={{
          id,
          describedBy: describedBy === '' ? undefined : describedBy,
          invalid: hasError,
          required,
        }}
      >
        {children}
      </FieldContext>
      {hasHelp ? (
        <p id={helpId} className="ui-field__help">
          {help}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="ui-field__error">
          <Icon name="warning" size="sm" className="ui-field__error-icon" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
