import { PageHeading } from './PageHeading';
import { Button } from './ui/button/Button';

/**
 * What the user sees when part of the application fails. It is deliberately generic: the diagnostic
 * message can carry credentials or personal data, and the Ops Portal specification (surfaces/
 * ops-portal.md §8) says the error state "never shows the diagnostic message". Retry is its own
 * explicit action, separate from the statement of what went wrong. `role="alert"` announces it.
 */
export function ErrorFallback({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div role="alert">
      <title>Something went wrong · Melarc Ops Portal</title>
      <PageHeading>Something went wrong</PageHeading>
      <p>The page could not be shown.</p>
      <Button
        type="button"
        onClick={(event) => {
          // The button is about to disappear. Park focus on the page content so a keyboard user is not
          // dropped back to the top of the document.
          event.currentTarget.closest('main')?.focus();
          onRetry();
        }}
      >
        Try again
      </Button>
    </div>
  );
}
