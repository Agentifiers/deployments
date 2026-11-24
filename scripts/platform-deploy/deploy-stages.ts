export type DeployStageKind = "configure" | "publish" | "record" | "terraform" | "verify";

export interface DeployStage {
  readonly condition: string | null;
  readonly id: string;
  readonly kind: DeployStageKind;
}

export const deployStages = [
  { condition: null, id: "callerAccount", kind: "verify" },
  { condition: null, id: "init", kind: "terraform" },
  {
    condition:
      "OpenTofu state lacks the artifact bucket's versioning resource or an artifact store output",
    id: "apply:artifact-store",
    kind: "terraform",
  },
  { condition: null, id: "publishImages", kind: "publish" },
  {
    condition: "the profile enables Lambda MicroVM",
    id: "apply:lambda-microvm-prerequisites",
    kind: "terraform",
  },
  {
    condition: "the profile enables Lambda MicroVM",
    id: "publishMicrovmImage",
    kind: "publish",
  },
  { condition: null, id: "publishLambdaArtifacts", kind: "publish" },
  { condition: null, id: "apply:model-runtime-secrets", kind: "terraform" },
  { condition: null, id: "syncModelRuntime:prepare", kind: "configure" },
  { condition: null, id: "reconcileOrganizationGateLanes:prepare", kind: "configure" },
  { condition: null, id: "apply:deployment", kind: "terraform" },
  { condition: "the profile enables Lambda MicroVM", id: "verifyMicrovm", kind: "verify" },
  {
    condition: "the agent_runtime_worker output is set",
    id: "verifyWorkerRollout",
    kind: "verify",
  },
  {
    condition: "the model_runtime_secret_arns output is a non-empty object",
    id: "syncModelRuntime:full",
    kind: "configure",
  },
  {
    condition: "the app_runtime output is set",
    id: "bootstrapAppDatabase",
    kind: "configure",
  },
  {
    condition: "the platform_identity_bootstrap output is set",
    id: "bootstrapIdentity",
    kind: "configure",
  },
  {
    condition: "the console_assets_bucket output is set",
    id: "publishConsoleAssets",
    kind: "publish",
  },
  { condition: null, id: "deployLambdas", kind: "publish" },
  { condition: null, id: "reconcileOrganizationGateLanes:repair", kind: "configure" },
  { condition: null, id: "migrateOrganizationLimits", kind: "configure" },
  {
    condition: "the search_placement_functions output names a function",
    id: "activateSearchPlacements",
    kind: "configure",
  },
  {
    condition:
      "the identity domain was unpublished and platform_identity_bootstrap reports publication_ready",
    id: "apply:identity-domain",
    kind: "terraform",
  },
  {
    condition: "the platform_api_endpoint output is set",
    id: "verifyPublicSurface",
    kind: "verify",
  },
  { condition: "the console_url output is set", id: "verifyConsole", kind: "verify" },
  { condition: null, id: "reconcileOrganizationGateLanes:final", kind: "configure" },
  { condition: null, id: "migrateGovernanceInventoryShards", kind: "configure" },
  { condition: null, id: "migrateMeterEventWorkspaces", kind: "configure" },
  { condition: null, id: "migrateArtifactCreationIndex", kind: "configure" },
  { condition: null, id: "recordInstallation", kind: "record" },
] as const satisfies readonly DeployStage[];

export type DeployStageId = (typeof deployStages)[number]["id"];

export type DeployStageRunner = <T>(stage: DeployStageId, run: () => Promise<T>) => Promise<T>;
