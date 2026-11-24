import type {
  AgentMemoryMode,
  AgentMemoryReviewMode,
  AgentMemoryTranscriptPrivacy,
  AgentPlatformSkillName,
  AgentSandboxPolicy,
  AgentTrigger,
} from "@deployments-ai/agent-manifest/schema";

export const TRIGGER_LABELS: Readonly<Record<AgentTrigger, string>> = {
  api: "API",
  chat: "Chat",
  email: "Email",
  heartbeat: "Heartbeat",
  schedule: "Schedule",
  webhook: "Webhook",
  workflow: "Workflow",
};

type SandboxMode = (typeof AgentSandboxPolicy.fields.mode.literals)[number];

export const SANDBOX_LABELS: Readonly<Record<SandboxMode, string>> = {
  none: "No sandbox",
  "run-ephemeral": "Fresh for each run",
  "thread-persistent": "Kept for the thread",
};

export const MEMORY_MODE_LABELS: Readonly<Record<typeof AgentMemoryMode.Type, string>> = {
  agent: "Shared across the agent's threads",
  off: "Off",
  organization: "Shared across the organization",
  thread: "Only within each thread",
  workspace: "Shared within each workspace",
};

export const REVIEW_MODE_LABELS: Readonly<Record<AgentMemoryReviewMode, string>> = {
  "auto-approve": "Approve automatically",
  manual: "Review each memory",
};

export const TRANSCRIPT_PRIVACY_LABELS: Readonly<Record<AgentMemoryTranscriptPrivacy, string>> = {
  omit: "Leave them out",
  redact: "Redact contact details",
  retain: "Keep them as written",
};

/** Instructions placeholder; a new agent starts with none, and the manifest requires them. */
export const INSTRUCTIONS_PLACEHOLDER = "Describe what the agent does and how it should answer.";

export const PLATFORM_SKILL_LABELS: Readonly<Record<AgentPlatformSkillName, string>> = {
  "app-builder": "Build a web app with the app tools",
  "app-publication": "Publish an app built with app-builder",
  "computer-use": "Operate the sandbox desktop with the computer tools",
};
