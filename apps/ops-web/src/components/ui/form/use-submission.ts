import { useEffect, useRef, useState, type RefObject, type SubmitEvent } from 'react';

/**
 * What a form's work came to. `accepted`: it was done. `invalid`: the form refused the input, shows an error on at least
 * one field and focus goes to the first of them. `failed`: it was not done, for a reason the form has shown elsewhere
 * (an alert, a retry); nothing moves focus.
 */
export type SubmissionResult = 'accepted' | 'invalid' | 'failed';

export interface Submission {
  /** The work is under way. Show it on the submit button (`loading`), and do not show success while it is true. */
  readonly pending: boolean;
  /** Spread on the `<form>`. */
  readonly formProps: {
    readonly ref: RefObject<HTMLFormElement | null>;
    /** The browser's own validation bubbles are off: the form's errors are the accessible ones the fields show. */
    readonly noValidate: true;
    readonly 'aria-busy': true | undefined;
    readonly onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  };
}

/**
 * The text a field of a form holds, or an empty string if it holds none (a file, or no such field). Read it at submit
 * time from the form, and do not keep it: a password in a form is read here and goes no further than the request.
 */
export function fieldText(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}

/** Whether a checkbox of a form is ticked. A name the form does not have, or a box left off, is false. */
export function fieldChecked(form: HTMLFormElement, name: string): boolean {
  return new FormData(form).has(name);
}

/**
 * Empties a text field of a form and hands it back, or does nothing for a name the form does not have or a control that is not an input. A
 * password or a code typed into a form is read at submit time and is not left in the field once the server has answered it.
 */
export function emptyField(form: HTMLFormElement, name: string): HTMLInputElement | undefined {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) return undefined;
  field.value = '';
  return field;
}

/** The first control of a form that says it is invalid. It does not look inside a closed `<details>` or a hidden panel. */
export function focusFirstInvalid(form: HTMLFormElement | null): boolean {
  const invalid = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (invalid === null || invalid === undefined) return false;
  invalid.focus();
  return true;
}

/**
 * What every form of the Ops Portal does around its own work (DESIGN_SYSTEM section 14, COMPONENT_PATTERNS section 6):
 *
 * - the browser's submit is prevented and its validation is off, so the form's own errors are the ones shown;
 * - while the work is under way a second submit is ignored, whether it came from the button, from Enter in a field, or
 *   from a script. The guard is a flag set at once, not the screen's state, which is not updated between two events in
 *   the same tick;
 * - when the work answers `invalid`, focus goes to the first invalid field once the errors are on the screen, and that
 *   field reads its error. Each failed submit does this again;
 * - nothing happens to a form that has left the page, such as a focus move into the page the person went to.
 *
 * The work reads the form (`new FormData(form)`) or the screen's own state, and sets the errors it finds. It must not
 * throw: if it does, the form is made usable again and the error is reported as an uncaught one (`reportError`), so it
 * reaches monitoring and is not swallowed. A secret in the form is read from the form at submit time and is not kept.
 */
export function useSubmission(
  work: (form: HTMLFormElement) => Promise<SubmissionResult>,
): Submission {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [pending, setPending] = useState(false);
  const [invalidAttempts, setInvalidAttempts] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latestWork = useRef(work);

  useEffect(() => {
    latestWork.current = work;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // After the errors are committed, so the field that is invalid already says so and its error is already linked.
  useEffect(() => {
    if (invalidAttempts > 0) focusFirstInvalid(formRef.current);
  }, [invalidAttempts]);

  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    inFlight.current = true;
    setPending(true);

    void (async () => {
      let result: SubmissionResult = 'failed';
      try {
        result = await latestWork.current(form);
      } catch (error) {
        reportUncaught(error);
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
      if (result === 'invalid' && mounted.current) setInvalidAttempts((count) => count + 1);
    })();
  };

  return {
    pending,
    formProps: {
      ref: formRef,
      noValidate: true,
      'aria-busy': pending ? true : undefined,
      onSubmit,
    },
  };
}

function reportUncaught(error: unknown): void {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else
    setTimeout(() => {
      throw error;
    });
}
