import {
  createStartHandler,
  defaultStreamHandler,
  defineHandlerCallback,
} from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { UnauthenticatedError } from "./errors.ts";

/**
 * The router reports every failed loader as 500; a missing session is an expected state, so the
 * rendered sign-in page is served as 401 instead.
 */
const renderDocument = defineHandlerCallback(async (context) => {
  const result = await defaultStreamHandler(context);
  const signInRequired = context.router.state.matches.some(
    (match) => match.error instanceof UnauthenticatedError,
  );
  if (!signInRequired) return result;
  const { body, headers } = result instanceof Response ? result : result.response;
  const response = new Response(body, { headers, status: 401 });
  // Streaming renders keep their cleanup hook; only the status changes.
  return result instanceof Response ? response : { ...result, response };
});

export default createServerEntry({ fetch: createStartHandler(renderDocument) });
