import { expect, test } from "bun:test";
import { observabilityCommandCatalog } from "./catalog-observability.ts";
import { buildRequest } from "./command-runtime.ts";
import type { ResolvedCliContext } from "./types.ts";

test("propagates workspace context through observability commands", async () => {
  const context: ResolvedCliContext = {
    apiKey: "token",
    apiUrl: "https://api.example.com",
    mock: false,
    organizationId: "organization-1",
    profileName: "default",
    workspaceId: "workspace-1",
  };
  const request = await buildRequest(
    observabilityCommandCatalog.trace!.actions.list!,
    {},
    context,
    {},
  );
  expect(request.context).toMatchObject({
    organizationId: "organization-1",
    workspaceId: "workspace-1",
  });
});
