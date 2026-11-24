import { firecrawlTableMetadata } from "./firecrawl-table.ts";
import type { ImageDeploymentMetadata } from "./image-metadata.ts";

export interface PlatformImage {
  readonly context: string;
  /** Exported document the deployment passes to OpenTofu alongside the image. */
  readonly deploymentMetadata?: ImageDeploymentMetadata;
  readonly dockerfile: string;
  readonly platform: string;
  readonly terraformVariable: string;
}

/**
 * Release images. `context` is the Docker build context relative to the
 * repository root; `dockerfile` is relative to the repository root as well.
 * Bifrost and Firecrawl build from pinned images of their forks alone, published
 * from github.com/Agentifiers/bifrost and the AGPL fork github.com/Agentifiers/firecrawl.
 * Firecrawl's DynamoDB table definition comes from the same pinned image.
 */
export const platformImages = {
  "agent-worker": {
    context: ".",
    dockerfile: "functions/worker/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "agent_worker_image",
  },
  "app-gateway": {
    context: ".",
    dockerfile: "apps/app-gateway/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "app_gateway_image",
  },
  bifrost: {
    context: "infrastructure/images/bifrost",
    dockerfile: "infrastructure/images/bifrost/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "bifrost_image",
  },
  "durable-streams": {
    context: ".",
    dockerfile: "apps/durable-streams/Dockerfile",
    platform: "linux/amd64",
    terraformVariable: "durable_streams_image",
  },
  firecrawl: {
    context: "infrastructure/images/firecrawl",
    deploymentMetadata: firecrawlTableMetadata,
    dockerfile: "infrastructure/images/firecrawl/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "web_tools_firecrawl_image",
  },
  "model-gateway": {
    context: ".",
    dockerfile: "apps/model-gateway/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "model_gateway_image",
  },
  "observability-hot-plane": {
    context: ".",
    dockerfile: "apps/observability-hot-plane/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "agent_observability_hot_image",
  },
  "stream-gateway": {
    context: ".",
    dockerfile: "apps/stream-gateway/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "stream_gateway_image",
  },
  "web-tools-proxy": {
    context: ".",
    dockerfile: "packages/web-tools-proxy/Dockerfile",
    platform: "linux/arm64",
    terraformVariable: "web_tools_proxy_image",
  },
} as const satisfies Record<string, PlatformImage>;

export type PlatformImageName = keyof typeof platformImages;

export const platformImageNames = Object.keys(platformImages) as readonly PlatformImageName[];

export const defaultEcrRepositories = {
  "agent-worker": "deployments-ai/platform/agent-worker",
  "app-gateway": "deployments-ai/platform/app-gateway",
  bifrost: "deployments-ai/platform/bifrost",
  "durable-streams": "deployments-ai/platform/durable-streams",
  firecrawl: "deployments-ai/platform/firecrawl",
  "model-gateway": "deployments-ai/platform/model-gateway",
  "observability-hot-plane": "deployments-ai/platform/observability-hot-plane",
  "stream-gateway": "deployments-ai/platform/stream-gateway",
  "web-tools-proxy": "deployments-ai/platform/web-tools-proxy",
} as const satisfies Record<PlatformImageName, string>;

/** Every root calls the reusable platform stack under this module address. */
export const platformStackModule = "module.platform";

/**
 * Code shape of an OpenTofu root. Every account-specific value comes from the
 * deployment target; a profile names the capabilities of the root it describes
 * and, when the root ships in this repository, its path. A profile without a
 * `terraformRoot` describes a root kept outside this repository, so its targets
 * must set `terraform.root`.
 */
export interface RootProfile {
  readonly allowMissingLambdas: boolean;
  readonly images: readonly PlatformImageName[];
  readonly lambdaMicrovm: boolean;
  readonly terraformRoot?: string;
}

export const rootProfiles = {
  "platform-dev": {
    allowMissingLambdas: false,
    images: [
      "agent-worker",
      "app-gateway",
      "bifrost",
      "durable-streams",
      "firecrawl",
      "model-gateway",
      "observability-hot-plane",
      "stream-gateway",
      "web-tools-proxy",
    ],
    lambdaMicrovm: true,
  },
  "platform-prod": {
    allowMissingLambdas: true,
    images: [
      "agent-worker",
      "app-gateway",
      "bifrost",
      "durable-streams",
      "firecrawl",
      "model-gateway",
      "observability-hot-plane",
      "stream-gateway",
      "web-tools-proxy",
    ],
    lambdaMicrovm: true,
  },
  "platform-customer": {
    allowMissingLambdas: true,
    images: [
      "agent-worker",
      "app-gateway",
      "bifrost",
      "durable-streams",
      "firecrawl",
      "model-gateway",
      "observability-hot-plane",
      "stream-gateway",
      "web-tools-proxy",
    ],
    lambdaMicrovm: true,
    terraformRoot: "infrastructure/environments/customer",
  },
} as const satisfies Record<string, RootProfile>;

export type RootProfileName = keyof typeof rootProfiles;

export const rootProfileNames = Object.keys(rootProfiles) as readonly RootProfileName[];
