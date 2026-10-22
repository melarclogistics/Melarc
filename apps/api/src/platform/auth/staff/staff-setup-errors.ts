/**
 * The credential setup operations (S0.31) were asked for in an application composed without a part they need: a database, local key
 * material for the pepper and the seals, or one of the ports built from them. Nothing was done, and nothing falls back to a stand-in
 * that pretends to have set a password: the platform answers its fixed, code-less `503` (`operational-failure.ts`), as it does for a
 * credential presented to an application with no session store.
 */
export class StaffSetupUnavailableError extends Error {
  constructor() {
    super('A credential setup was asked for and the application is not composed to carry it out');
    this.name = 'StaffSetupUnavailableError';
  }
}
