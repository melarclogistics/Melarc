import type { CopyRule } from './problem-copy';

/**
 * The words of the message log (S1.12e), keyed by operation and code like the rest of the table, and proposed for the Product Owner to review
 * with the composed screens. A refusal for want of `notification.read` is told by the screen itself (`ReadState` names the key and never a
 * role); these are the log's own failures. No wording names a number, a text or a code: the log has none to show.
 */
export const NOTIFICATION_COPY: readonly CopyRule[] = [
  { operation: 'listNotifications', text: 'The messages could not be loaded.' },
  {
    operation: 'listNotifications',
    code: 'VALIDATION_FAILED',
    text: 'That choice of messages was not accepted. Choose from the lists to start again.',
  },
];
