import { conversationErasureRoutes } from "./conversation-erasure-routes.ts";
import { getWebhookRoutes } from "./get-webhook-routes.ts";
import { listRunsRoutes } from "./list-runs-routes.ts";
import { previewRoutes } from "./preview-routes.ts";
import { runtimeLogRoutes } from "./runtime-log-routes.ts";
import type { RuntimeApiRouteContract } from "./runtime-contracts.ts";
import { updateScheduleRoutes } from "./update-schedule-routes.ts";
import { workflowExecutionRoutes } from "./workflow-execution-routes.ts";

export const RUNTIME_API_ROUTES = [
  ...listRunsRoutes,
  ...conversationErasureRoutes,
  ...getWebhookRoutes,
  ...updateScheduleRoutes,
  ...workflowExecutionRoutes,
  ...previewRoutes,
  ...runtimeLogRoutes,
] as const satisfies readonly RuntimeApiRouteContract[];
