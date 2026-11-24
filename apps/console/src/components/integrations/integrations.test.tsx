import {
  ChannelBindingResponse,
  ChannelDeliveryResponse,
} from "@deployments-ai/api-contract/runtime";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Schema } from "effect";
import { operationAccess } from "../../access.ts";
import { deploymentTargetsQuery } from "../../data/agent-email-inbox-queries.ts";
import { agentChannelsQuery } from "../../data/agent-runtime-queries.ts";
import { integrationEndpointsQuery } from "../../data/integration-queries.ts";
import type { IntegrationEndpoints } from "../../integrations/endpoints.ts";
import type { AgentDetail } from "../../server/agent-data.ts";
import type { AgentChannels } from "../../server/agent-runtime-data.ts";
import { renderWith } from "../apps/app-fixtures.tsx";
import { ChannelBindings } from "../agents/runtime/channel-bindings.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { IntegratePage } from "./integrate-page.tsx";

const ORG = "01K000000000000000000000G1";
const PROJECT = "01K000000000000000000000P1";
const ENV = "01K000000000000000000000E1";
const AGENT = "01K000000000000000000000A1";
const DEPLOYMENT = "01K000000000000000000000D1";
const BINDING = "01K000000000000000000000B1";
const RUN = "01K000000000000000000000R1";
const THREAD = "01K000000000000000000000T1";
const AT = "2026-10-01T00:00:00.000Z";
const scope = { environmentId: ENV, organizationId: ORG, projectId: PROJECT };
const tenant = { environmentId: ENV, organizationId: ORG, projectId: PROJECT };

const endpoints: IntegrationEndpoints = {
  channelApi: "https://channels.example.com",
  docs: "https://docs.example.com",
  platformApi: "https://api.example.com",
  streamGateway: "https://streams.example.com",
};

const agent = {
  definition: { ...tenant, id: AGENT },
  deployments: [{ id: DEPLOYMENT }],
  releases: [],
} as unknown as AgentDetail;

const channels: AgentChannels = {
  bindings: [
    Schema.decodeUnknownSync(ChannelBindingResponse)({
      ...tenant,
      agentDefinitionId: AGENT,
      agentDeploymentId: DEPLOYMENT,
      channel: "slack",
      createdAt: AT,
      credentialAttached: true,
      externalWorkspaceId: "T0123",
      id: BINDING,
      lastVerifiedAt: AT,
      object: "channel-binding",
      provider: "slack_edge",
      status: "active",
      updatedAt: AT,
      version: 2,
    }),
  ],
  deliveries: [
    Schema.decodeUnknownSync(ChannelDeliveryResponse)({
      ...tenant,
      attempts: 3,
      bindingId: BINDING,
      channel: "slack",
      contentPreview: "Here is the summary you asked for.",
      createdAt: AT,
      externalThreadKey: "T0123:C0456:1700000000.000100",
      failedAt: AT,
      id: "01K00000000000000000000DV1",
      lastError: "channel_not_found",
      object: "channel-delivery",
      provider: "slack_edge",
      runId: RUN,
      status: "failed",
      threadId: THREAD,
      updatedAt: AT,
      version: 3,
    }),
  ],
  deliveriesComplete: true,
  ingressOrigin: "https://channels.example.com",
};

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(integrationEndpointsQuery().queryKey, endpoints);
  queryClient.setQueryData(agentChannelsQuery(scope, AGENT, [DEPLOYMENT]).queryKey, channels);
  queryClient.setQueryData(deploymentTargetsQuery(scope).queryKey, [
    { agentName: "Deployment Smoke", definitionId: AGENT, id: DEPLOYMENT },
  ]);
  return queryClient;
}

async function routed(ui: ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => ui }),
  });
  await router.load();
  return <RouterProvider router={router} />;
}

const access = operationAccess({
  capabilities: effectiveOrganizationCapabilities("admin", PLATFORM_CLI_SCOPES),
  organizationRole: "admin",
});

describe("Channels tab", () => {
  test("lists bindings and deliveries read only, with the ingress URL in the binding drawer", async () => {
    await renderWith(
      client(),
      await routed(<ChannelBindings agent={agent} scope={scope} />),
      async (view) => {
        const text = view.document.body.textContent ?? "";
        expect(text).toContain("slack_edge");
        expect(text).toContain("channel_not_found");
        expect(text).not.toContain("CLI");
        expect(
          [...view.document.querySelectorAll("button")].map((button) => button.textContent),
        ).not.toContainEqual(expect.stringMatching(/create|verify|delete|archive|credential/iu));
        const reference = view.document.querySelector<HTMLAnchorElement>(
          'a[href="https://docs.example.com/docs/api/reference/runtime/create-channel-binding/"]',
        );
        expect(reference?.textContent).toBe("Channel binding API reference");

        const open = [...view.document.querySelectorAll("button")].find(
          (button) => button.textContent === "slack",
        );
        await view.click(open);
        expect(
          view.document.querySelector('[role="region"][aria-label="Ingress URL"]')?.textContent,
        ).toBe(`https://channels.example.com/public/channels/${ORG}/${ENV}/${BINDING}/slack_edge`);
        expect(view.document.querySelector('button[aria-label="Copy Ingress URL"]')).not.toBeNull();
      },
    );
  });
});

describe("Integrate page", () => {
  test("shows each endpoint and a submit-run request for the chosen deployment", async () => {
    await renderWith(
      client(),
      await routed(
        <IntegratePage
          access={access}
          deploymentId={undefined}
          endpoints={endpoints}
          onDeployment={() => undefined}
          scope={scope}
        />,
      ),
      async (view) => {
        const block = (label: string) =>
          view.document.querySelector(`[role="region"][aria-label="${label}"]`)?.textContent;
        expect(block("Platform API URL")).toBe("https://api.example.com");
        expect(block("Stream gateway URL")).toBe("https://streams.example.com");
        expect(block("Submit a run")).toContain(
          `-X POST "https://api.example.com/v1/agent-deployments/${DEPLOYMENT}/runs"`,
        );
        expect(block("Submit a run")).toContain('-H "idempotency-key: $(uuidgen)"');
        expect(block("Channel ingress URL pattern")).toBe(
          `https://channels.example.com/public/channels/${ORG}/${ENV}/{bindingId}/{provider}`,
        );
        expect(
          view.document.querySelector('button[aria-label="Copy Submit a run"]'),
        ).not.toBeNull();
      },
    );
  });

  test("leaves out the origins the install does not run", async () => {
    await renderWith(
      client(),
      await routed(
        <IntegratePage
          access={access}
          deploymentId={undefined}
          endpoints={{ platformApi: "https://api.example.com" }}
          onDeployment={() => undefined}
          scope={scope}
        />,
      ),
      async (view) => {
        const labels = [...view.document.querySelectorAll('[role="region"]')].map((region) =>
          region.getAttribute("aria-label"),
        );
        expect(labels).not.toContain("Stream gateway URL");
        expect(labels).not.toContain("Channel ingress URL pattern");
        expect(view.document.body.textContent).not.toContain("Guide");
      },
    );
  });
});

describe("ListEmpty", () => {
  test("offers the console action and the guide instead of a CLI command", async () => {
    await renderWith(
      client(),
      await routed(
        <ListEmpty
          action={<button type="button">Create workspace</button>}
          docs="/docs/capabilities/tenancy"
          icon={Folder01Icon}
          title="No workspaces"
        >
          A workspace groups runs.
        </ListEmpty>,
      ),
      async (view) => {
        expect(view.document.body.textContent).not.toContain("CLI");
        expect(view.document.querySelector("button")?.textContent).toBe("Create workspace");
        expect(
          view.document.querySelector(
            'a[href="https://docs.example.com/docs/capabilities/tenancy"]',
          )?.textContent,
        ).toBe("Read the docs");
      },
    );
  });
});
