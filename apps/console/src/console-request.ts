/**
 * The most a browser may send in one server-function request. The console's Lambda receives the
 * request as one event, and base64 file content and escaped text must stay under its ~6 MB cap.
 */
export const MAX_CONSOLE_REQUEST_BYTES = 4_500_000;
