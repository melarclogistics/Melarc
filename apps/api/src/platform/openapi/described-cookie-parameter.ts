import { ApiParam } from '@nestjs/swagger';

/**
 * States the trusted-browser credential as a **cookie parameter** of an operation, as the contract's `TrustedBrowserCookie` does
 * (staff-authentication.md §5.8): optional, any text up to 512 characters, judged where it is used. `@nestjs/swagger` offers no decorator
 * for a cookie, and `ApiParam` writes whatever location it is given after its own default, so this is the one place that says `cookie`.
 * The conformance check compares the result with the contract's parameter, so a name or a schema that drifts is a finding.
 */
export function DescribeTrustedBrowserCookie(): MethodDecorator {
  return ApiParam({
    name: 'melarc_trusted_browser',
    in: 'cookie',
    required: false,
    schema: { type: 'string', maxLength: 512 },
  } as Parameters<typeof ApiParam>[0]);
}
