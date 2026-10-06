// Built by test/build.test.ts, never by the application. It reads one public and one server-only
// variable the way browser code would, so the test can see which of them Vite lets through.
export const exposed = import.meta.env.VITE_TEST_PUBLIC_FLAG as unknown;
export const serverOnly = import.meta.env.MELARC_TEST_SERVER_SECRET as unknown;
