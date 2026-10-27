import { Button } from '../../../components/ui/button/Button';
import type { ConfirmedCommand } from '../../../platform/api/use-confirmed-command';

/**
 * The way out of a code that may or may not have been made (COMPONENT_PATTERNS section 33.2): **look at the rider** always, which abandons
 * the attempt and reads the rider again, and **try again** only for an act that takes an `Idempotency-Key`, so that the same attempt is
 * repeated under the same key and no second code is made. Whether the act can be sent again is the command's to say (`canRetry`), never the
 * page's: the first binding says so, a replacement (which takes no key) does not.
 */
export function CodeRecovery({
  command,
}: {
  readonly command: Pick<ConfirmedCommand<object>, 'canRetry' | 'checkRecord' | 'retry'>;
}) {
  return (
    <>
      <Button type="button" variant="secondary" data-recovery onClick={command.checkRecord}>
        Check the rider
      </Button>
      {command.canRetry ? (
        <Button
          type="button"
          onClick={() => {
            void command.retry();
          }}
        >
          Try again
        </Button>
      ) : null}
    </>
  );
}
