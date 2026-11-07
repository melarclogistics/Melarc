import './operational-code.css';

export interface OperationalCodeProps {
  /** The code, exactly as the server gave it: `ACC-PR-7KQ2MZ`. It is never shortened, re-cased or re-punctuated here. */
  readonly children: string;
}

/**
 * An operational code (a request, a manifest, a rider) in the monospaced face (DESIGN_SYSTEM section 5.1, weight 600). People read these aloud on calls,
 * so the whole code is always shown and never truncated (COMPONENT_PATTERNS section 24.1): it does not wrap, and copying it gives the characters shown.
 * It decides nothing and names nothing; what the code is of is the words around it.
 */
export function OperationalCode({ children }: OperationalCodeProps) {
  return <span className="ui-code">{children}</span>;
}
