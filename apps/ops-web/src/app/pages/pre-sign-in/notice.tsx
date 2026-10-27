import { useEffect, useRef, type ReactNode } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';

/**
 * What a pre-sign-in screen shows when a call did not come to its end: the words, and the request id for a person to quote when the server
 * failed. Never the server's message.
 */
export interface Notice {
  readonly message: string;
  /** The request id, shown only when the server could not finish: a person asking for help can quote it. */
  readonly reference?: string;
}

/**
 * The words for a failure that is not about a field or a state of its own. A call that got no answer, or an answer that was not the API's, is
 * worded as an unknown outcome of this operation; everything else is worded by the operation, context and code of the table. The reference is
 * kept for the failures that are the server's, and left out of the ones that are the person's (a refused password, a wait).
 */
export function noticeOf(problem: Problem, operation: string): Notice {
  if (problem.kind === 'unavailable') {
    return {
      message: copyFor({ operation, context: 'unknown-outcome' }) ?? problem.message,
      ...(problem.reference === undefined ? {} : { reference: problem.reference }),
    };
  }
  return { message: problem.message };
}

/** Whether the server refused a particular field of the request, by the place it names (a JSON pointer such as `/password`). */
export function refusesField(problem: Problem, pointer: string): boolean {
  return problem.violations?.some((violation) => violation.pointer === pointer) ?? false;
}

/** An alert inserted into a page that is already showing, because of something the person just did: announced at once. */
export function FormNotice({ notice }: { readonly notice: Notice }) {
  return (
    <Alert variant="danger" announce>
      <p>{notice.message}</p>
      {notice.reference === undefined ? null : <p>Reference: {notice.reference}</p>}
    </Alert>
  );
}

/**
 * A part of a page the person is taken to by what they just did: the form was replaced by an outcome, and the button they pressed has gone
 * with it. Focus moves here, so a keyboard user is not dropped at the top of the document and a screen reader reads where they are. Nothing
 * here is a control; the region can take focus and is not a tab stop.
 */
export function FocusedRegion({ children }: { readonly children: ReactNode }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, []);
  return (
    <div ref={region} tabIndex={-1}>
      {children}
    </div>
  );
}
