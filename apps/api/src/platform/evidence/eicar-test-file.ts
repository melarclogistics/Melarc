/**
 * The standard EICAR antivirus test file (eicar.org): 68 printable characters that every scanner treats as a virus and that can harm nothing. The in-process stand-in of the content
 * scanner recognises it and nothing else, and the smoke command (`evidence:smoke`) asks the real scanner about it. It lives in a file of its own so that a tool can name it without
 * importing an adapter (only the composition root may).
 */
export const EICAR_TEST_FILE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
