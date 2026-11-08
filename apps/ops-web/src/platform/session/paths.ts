/**
 * Where the guards send a person, and where the pre-sign-in screens are. `/sign-in` is the sign-in screen (S0.43); a session that ends
 * anywhere returns to the landing, whose guard sends the person here with nothing that says why (surfaces/ops-portal.md section 7).
 */
export const SIGN_IN_PATH = '/sign-in';

/** The second step of a privileged sign-in. It holds a challenge, not a session. */
export const SIGN_IN_MFA_PATH = '/sign-in/mfa';

/** Where an employee sets their own first password, from the grant a message carries in its fragment. */
export const SETUP_CREDENTIAL_PATH = '/setup/credential';

/** Where a privileged employee enrols an authenticator: from the first password, or from a re-enrolment link after a reset. */
export const SETUP_MFA_PATH = '/setup/mfa';

/** The confirmation after an authenticator is proven. It states that the next step is an ordinary sign-in. */
export const SETUP_MFA_COMPLETE_PATH = '/setup/mfa/complete';

/** Where a staff member who has forgotten their password asks for a recovery link (S0.52a). It says the same thing whoever asks. */
export const RECOVERY_PATH = '/recovery';

/** Where a staff member sets a new password from the recovery link a message carries in its fragment (S0.52a). */
export const RECOVERY_COMPLETE_PATH = '/recovery/complete';

/** The signed-in landing. A session that ended elsewhere returns here, and the guard sends it on to sign-in. */
export const LANDING_PATH = '/';
