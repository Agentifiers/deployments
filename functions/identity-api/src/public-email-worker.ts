import { runtimeApplication } from "./identity-runtime.ts";
import { makePublicEmailRequestProcessor } from "./public-email-requests.ts";

export const handler = makePublicEmailRequestProcessor(runtimeApplication());
