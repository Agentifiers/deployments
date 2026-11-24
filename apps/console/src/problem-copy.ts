import type { ConsoleOperation } from "./access.ts";
import type { InstallCopy } from "./edition.ts";

/** A bare 403's explanation; the API operation name means nothing to the person refused. */
export const REFUSED = "Your role or API key scopes do not allow this action.";

export interface ProblemCopy {
  /** A function when who can fix the problem depends on who runs the install. */
  readonly description?: string | ((copy: InstallCopy) => string);
  readonly title: string;
}

/**
 * A `description` replaces the server's message, so set one only for codes whose server text is
 * generic.
 */
export const PROBLEM_COPY: Readonly<Record<string, ProblemCopy>> = {
  ambiguous_write_outcome: {
    description:
      "The platform could not confirm whether the change applied. Reload and check before trying again.",
    title: "The outcome is unknown",
  },
  app_domain_limit_reached: { title: "This app has the most domains it can hold" },
  app_erasure_unavailable: { title: "App erasure is not available yet" },
  app_state_conflict: { title: "Not possible in the app's current state" },
  approval_already_resolved: { title: "Approval already resolved" },
  attachment_limit_exceeded: { title: "Attachments too large" },
  binding_conflict: { title: "Already bound" },
  binding_limit_exceeded: { title: "Binding limit reached" },
  brain_answer_invalid: {
    description:
      "The answer model twice returned an answer the platform could not check against the evidence. Ask again or rephrase the question.",
    title: "No checked answer",
  },
  brain_brain_inactive: {
    description: "This Brain is archived or being erased, so it cannot be read or changed.",
    title: "Brain inactive",
  },
  brain_caller_grant_invalid: {
    description: "You hold no grant on this Brain. Ask one of its owners for one.",
    title: "No access to this Brain",
  },
  brain_document_not_found: { title: "Document not found" },
  brain_entity_not_found: { title: "Entity not found" },
  brain_erasure_in_progress: {
    description: "This Brain is already being erased.",
    title: "Erasure already started",
  },
  brain_erasure_not_found: { title: "Erasure not found" },
  brain_human_curator_required: { title: "Only a person can resolve review items" },
  brain_merge_target_required: { title: "Choose the entity to merge into" },
  brain_permission_denied: {
    description:
      "A private Brain is open only to its owner. On a company Brain, your grant does not allow this; access and settings need an owner grant.",
    title: "Not allowed on this Brain",
  },
  brain_query_attempt_not_found: { title: "Query not found" },
  brain_query_scope_not_found: {
    description:
      "One of the chosen Brains is archived, or you hold no grant on it. Choose again from the list.",
    title: "Brain unavailable",
  },
  brain_query_timeout: {
    description: "The search or answer took longer than the request allows. Try again.",
    title: "Brain query timed out",
  },
  brain_restore_content_missing: { title: "No content to restore" },
  brain_review_version_conflict: { title: "Review item changed" },
  brain_search_unavailable: {
    description: (copy) => copy.brainSearchUnavailable,
    title: "Brain search not configured",
  },
  brain_upload_quota_exceeded: {
    description:
      "Too many uploads are unfinished or were started recently, for you, this Brain, or the organization. Wait for unfinished uploads to expire, then try again.",
    title: "Upload limit reached",
  },
  brain_upload_restart: {
    description:
      "The document was not captured, and this upload can no longer finish. Upload again to start a new one.",
    title: "Upload did not finish",
  },
  brain_upload_ticket_not_consumable: { title: "Upload expired" },
  brain_upload_ticket_not_found: { title: "Upload expired" },
  brain_version_conflict: {
    description: "Someone changed the Brain since this page loaded. Reload it and try again.",
    title: "Brain changed",
  },
  budget_archived: { title: "Budget archived" },
  budget_changed: { title: "Budget changed" },
  budget_exhausted: { title: "Budget exhausted" },
  budget_limit_exceeded: { title: "Budget limit reached" },
  callback_auth_replacement_required: {
    description: "Changing an HTTP callback's endpoint requires a new callback secret.",
    title: "New callback secret required",
  },
  canary_active: {
    description: "Promote or abort the canary before changing what this deployment runs.",
    title: "Canary in progress",
  },
  client_secret_required: { title: "Client secret required" },
  connection_inactive: {
    description: "Only an active connection can be granted. Verify it again first.",
    title: "Connection not active",
  },
  connection_not_vendor_mcp: {
    description: "Only connections to a vendor-hosted MCP provider can sync tools.",
    title: "Not a vendor MCP connection",
  },
  connection_not_verifiable: {
    description:
      "The platform can check only a stored credential whose last rotation finished, and an OAuth connection that needs reauthorization must be authorized again first.",
    title: "Connection cannot be verified",
  },
  connection_not_verified: {
    description: "Verify the connection so it records a capability, then grant it.",
    title: "Connection not verified",
  },
  credential_missing: { title: "No stored credential to rotate" },
  daily_outbound_limit_exceeded: { title: "Daily sending limit reached" },
  default_domain_unavailable: {
    description:
      "This environment does not have exactly one verified domain, so pick the inbox's domain.",
    title: "Choose a domain",
  },
  default_placement_conflict: {
    description: "This environment already has a default placement. Change that one instead.",
    title: "Default placement exists",
  },
  deployment_not_editable: { title: "This deployment cannot be edited now" },
  deployment_stopped: { title: "A stopped deployment cannot be updated" },
  deployment_unavailable: {
    description: "The deployment is not ready and running. Start it, or choose another one.",
    title: "Deployment unavailable",
  },
  dns_lookup_failed: { title: "DNS lookup failed" },
  domain_claimed: { title: "Another organization verified this domain" },
  domain_conflict: {
    description: "This environment already has that email domain.",
    title: "Domain already added",
  },
  domain_not_verified: {
    description: "Publish the domain's DNS records and refresh it until it is verified.",
    title: "Domain not verified",
  },
  draft_not_approved: {
    description: "Only approved drafts can be sent.",
    title: "Draft not approved",
  },
  draft_not_editable: {
    description: "Only drafts in draft or rejected status can be edited.",
    title: "Draft cannot be edited",
  },
  email_domain_not_verified: {
    description: "Verify the From domain in this sending tenant first.",
    title: "From domain not verified",
  },
  email_domain_revoked: {
    description: "Revoked domains cannot be refreshed. Add the domain again.",
    title: "Domain revoked",
  },
  email_sending_paused: { title: "Sending paused" },
  email_tenant_paused: {
    description: "Resume the sending tenant before sending.",
    title: "Sending tenant paused",
  },
  enforcement_requires_federated_session: {
    title: "Sign in through the identity provider first",
  },
  erasure_requires_signed_identity: {
    description:
      "Erasure must be requested by a signed-in person, who can still read the receipt after API keys are deleted.",
    title: "Sign in to erase",
  },
  extension_execution_type_immutable: {
    description: "Create a new extension for a different execution type, then archive this one.",
    title: "Execution type cannot change",
  },
  governance_operation_conflict: {
    description: "This request's operation ID belongs to a different request. Start a new request.",
    title: "Operation already recorded",
  },
  hosted_code_artifact_conflict: {
    description:
      "An artifact with the same content is already stored with a different language. Choose that language or change the source.",
    title: "Hosted code language conflict",
  },
  hosted_code_artifact_not_found: {
    description: "Upload the hosted code artifact to this environment before declaring the tool.",
    title: "Hosted code not uploaded",
  },
  hosted_code_compile_failed: { title: "Hosted code did not compile" },
  hosted_domain_region_unsupported: { title: "Region not supported" },
  hostname_reserved: { title: "Hostname reserved by the platform" },
  idempotency_conflict: {
    title: "Close this dialog and check whether the earlier attempt applied",
  },
  inbox_address_conflict: {
    description: "Another inbox already uses this address. Choose a different one.",
    title: "Address in use",
  },
  inbox_not_active: {
    description: "Only active inboxes can send. Resume the inbox first.",
    title: "Inbox not active",
  },
  input_artifact_unavailable: {
    description:
      "This run's input files are private to the person, service account, or channel that submitted it. Only the person or service account that submitted the run can retry or replay it. If a channel submitted it, no one can.",
    title: "Input files unavailable",
  },
  insufficient_role: { title: "Your organization role does not permit this" },
  invalid_agent_deployment_config: { title: "Configuration does not match the release" },
  invalid_cursor: {
    description: "Reload the list from the start.",
    title: "This list's position is no longer valid",
  },
  invalid_draft_transition: { title: "Draft status changed" },
  invalid_heartbeat: { title: "The platform rejected the heartbeat interval or window" },
  invalid_hostname: { title: "Invalid hostname" },
  invalid_interval: { title: "The platform rejected the interval" },
  invalid_mcp_auth: { title: "MCP authentication rejected" },
  invalid_model_policy: { title: "Model policy rejected" },
  invalid_oauth_resource: {
    description:
      "The provider does not accept this tenant URL. Check it against the provider's MCP server address.",
    title: "Tenant URL not accepted",
  },
  invalid_return_to: {
    description: (copy) => copy.oauthReturnUnavailable,
    title: "This console cannot receive OAuth callbacks",
  },
  invalid_schedule: { title: "The platform rejected the schedule expression" },
  invalid_scope: { title: "Scopes not allowed" },
  invalid_secret: { title: "Credential rejected" },
  invalid_time_range: { title: "Invalid time range" },
  invalid_timezone: { title: "Unknown time zone" },
  invalid_usage_range: { title: "Invalid usage range" },
  invitation_accepted: {
    description: "The invitee already joined. Manage them in the members list.",
    title: "Invitation already accepted",
  },
  last_owner_required: {
    description: "Make another member an owner first.",
    title: "An owner is required",
  },
  managed_skill_install_conflict: {
    description:
      "The skill release or the agent is no longer active. Reload and choose an active one.",
    title: "Skill cannot be installed",
  },
  managed_skill_release_mismatch: {
    description:
      "The skill does not belong to the selected release. Reload the release and try again.",
    title: "Skill not in this release",
  },
  mcp_auth_replacement_required: {
    description:
      "Changing an authenticated MCP server's endpoint requires replacing its authentication.",
    title: "New authentication required",
  },
  mcp_authorization_server_mismatch: {
    description:
      "The provider's OAuth metadata no longer matches what the platform pinned for it, so connecting stays blocked until the platform reviews the change.",
    title: "The provider's authorization server changed",
  },
  mcp_discovery_credential_echo: { title: "MCP server returned credential material" },
  mcp_discovery_failed: { title: "The provider's MCP server did not answer" },
  mcp_discovery_mismatch: {
    description:
      "The server offered a tool its allowlist does not include. Widen the allowlist or remove the tool on the server.",
    title: "Discovered tool outside the allowlist",
  },
  mcp_server_inactive: {
    description: "Choose an active MCP server, or restore this one first.",
    title: "MCP server not active",
  },
  mcp_tool_not_allowed: {
    description: "Choose an active MCP server whose allowlist includes this remote tool.",
    title: "MCP tool not allowed",
  },
  member_inactive: {
    description: "Only active members can change roles.",
    title: "Member is not active",
  },
  message_not_reprocessable: {
    description: "Only inbound messages whose original is still stored can be reprocessed.",
    title: "Message cannot be reprocessed",
  },
  model_not_allowed_by_environment_policy: {
    title: "Model not allowed by the environment's model policy",
  },
  model_not_in_catalog: { title: "Model not in the platform catalog" },
  model_policy_exists: {
    description: "This environment already has an active model policy. Edit or archive it instead.",
    title: "Model policy already exists",
  },
  not_an_organization_member: { title: "Not an active member of this organization" },
  oauth_application_secret_required: {
    description: "Rotate the OAuth app's client secret, then connect again.",
    title: "OAuth app has no client secret",
  },
  oauth_provider_unconfigured: {
    description: (copy) => copy.oauthProviderUnconfigured,
    title: "OAuth is not configured for this provider",
  },
  oauth_redirect_uri_mismatch: { title: "Redirect URI does not match the platform callback" },
  observability_initializing: {
    description: "The observability hot plane is starting and will answer queries shortly.",
    title: "Observability is starting",
  },
  observability_query_capacity_exceeded: {
    description: "The observability query service is busy. Try again in a few seconds.",
    title: "Observability is busy",
  },
  observability_query_concurrency_exceeded: {
    description: "Too many observability queries are running for this organization.",
    title: "Observability is busy",
  },
  // Who can fix it depends on the install, so section boundaries show `ObservabilityUnavailable`.
  observability_unavailable: {
    description: "Traces, metrics, and run totals cannot be read right now.",
    title: "Observability is unavailable",
  },
  operator_access_required: {
    description:
      "Platform administrators need open operator access to an organization before reading or changing its data. Open it from the organization's System page; the organization sees it in its audit log.",
    title: "Operator access required",
  },
  organization_domain_limit_reached: {
    title: "The organization has the most app domains it can hold",
  },
  organization_erased: {
    description: "This organization has been erased and accepts no further changes.",
    title: "Organization erased",
  },
  placement_not_ready: {
    description: "The inbox needs exactly one active, provisioned placement before it can send.",
    title: "Sending placement not ready",
  },
  placement_required: {
    description: "Create an active default placement before adding a custom domain.",
    title: "Default placement required",
  },
  provider_application_mismatch: {
    description:
      "The chosen OAuth app is no longer active, or it belongs to another provider. Reload the page and choose an active app.",
    title: "OAuth app cannot be used",
  },
  provider_application_required: {
    description:
      "Register an OAuth app for this provider on the OAuth apps tab. When several apps are active, choose the one to use.",
    title: "OAuth app required",
  },
  provider_unavailable: {
    description: "This provider is not configured in this deployment.",
    title: "Provider unavailable",
  },
  raw_message_unavailable: {
    description: "The raw message has passed its retention and cannot be downloaded.",
    title: "Original message no longer stored",
  },
  recipient_blocked: { title: "Recipient blocked" },
  recipient_not_verified: { title: "Recipient not verified for warmup" },
  recipient_required: {
    description: "A message needs at least one To, Cc, or Bcc address.",
    title: "Add a recipient",
  },
  registration_method_unsupported: { title: "Provider does not accept registered OAuth apps" },
  release_archived: { title: "Release archived" },
  release_unavailable: {
    description: "The deployment's release is no longer active, so it cannot start runs.",
    title: "Release unavailable",
  },
  reply_recipient_unavailable: {
    description: "The original message has no sender or reply-to address.",
    title: "No one to reply to",
  },
  resource_inactive: { title: "Not active" },
  retention_policy_changed: {
    description: "The page reloaded the policy. Review the values and save again.",
    title: "Retention policy changed since you opened it",
  },
  retention_policy_conflict: {
    description: "Another change was applied at the same time. Reload the policy and try again.",
    title: "Retention policy changed",
  },
  rotation_cleanup_pending: {
    description:
      "An earlier rotation of this credential did not finish, and only the same request with the same values and idempotency key can finish it. If the dialog that started it is closed, revoke this connection, add a new one, verify it, and grant it again.",
    title: "Rotation not finished",
  },
  run_not_retryable: { title: "Run cannot be retried" },
  scheduled_at_in_past: {
    description: "Choose a time in the future.",
    title: "Scheduled time has passed",
  },
  scheduled_message_already_sending: {
    description: "The scheduled message started sending and can no longer be canceled.",
    title: "Already sending",
  },
  service_account_disabled: {
    description:
      "A revoked service account cannot issue or rotate API keys. Create a new service account instead.",
    title: "Service account revoked",
  },
  suppression_conflict: {
    description: "This address is already on the suppression list.",
    title: "Already suppressed",
  },
  tenant_artifact_uploads_pending: {
    description: "Erasure waits for outstanding artifact upload links to expire. Resume later.",
    title: "Artifact uploads pending",
  },
  tenant_brain_uploads_pending: {
    description: "Erasure waits for active Brain content streams to end. Resume later.",
    title: "Brain uploads pending",
  },
  tenant_erasure_already_requested: {
    description:
      "Another person requested erasure of this organization. Follow that request instead.",
    title: "Erasure already requested",
  },
  tenant_erasure_in_progress: { title: "Erasure in progress" },
  tenant_governance_busy: {
    description:
      "Erasure waits for exports and other governance operations to finish. Resume later.",
    title: "Other governance work running",
  },
  tenant_has_active_runs: {
    description: "Erasure waits until no run is active. Stop or let the runs finish, then resume.",
    title: "Runs still active",
  },
  tool_bindings_changed: {
    description:
      "The page reloaded the deployment. Your unsaved choices are kept on top of the new bindings; review and save again.",
    title: "Tool bindings changed since you opened this page",
  },
  tool_name_reserved: {
    description: "A built-in tool already uses this name. Choose another name.",
    title: "Tool name reserved",
  },
  trigger_not_allowed: {
    description:
      "The deployment's agent release does not allow this kind of automation. Choose another deployment, or release the agent with this trigger allowed.",
    title: "Trigger not allowed",
  },
  txt_not_found: { title: "TXT record not found" },
  unsafe_input_schema: {
    description:
      "Extension input schemas cannot use pattern or patternProperties. Remove those keywords.",
    title: "Input schema not allowed",
  },
  validation_failed: { title: "The platform rejected the request" },
  vendor_mcp_unconfigured: {
    description: "This deployment cannot connect vendor MCP providers over OAuth.",
    title: "Vendor OAuth unavailable",
  },
  version_conflict: { title: "Changed since you opened it" },
  webhook_endpoint_inactive: {
    description: "Only deliveries to an active endpoint can be retried. Enable the endpoint first.",
    title: "Webhook endpoint inactive",
  },
  webhook_subscription_limit: { title: "Webhook endpoint limit reached" },
  workflow_execution_not_found: { title: "Workflow execution not found" },
  workspace_unavailable: {
    description: "The workspace is archived. Choose another workspace or none.",
    title: "Workspace unavailable",
  },
};

const RENAME_CONFLICT: Readonly<Record<string, ProblemCopy>> = {
  resource_conflict: {
    description:
      "Another resource there already uses this slug, or someone saved a change at the same moment. Reload the page, then choose another slug or try again.",
    title: "Not saved",
  },
};

const UPLOAD_DENIED: ProblemCopy = {
  description: "Uploading to this Brain needs a writer, curator, or owner grant on it.",
  title: "Not allowed to upload",
};

function memorySearchNotEnabled(action: string): ProblemCopy {
  return {
    description: (copy) => copy.memorySearchNeeded(action),
    title: "Memory search may not be enabled for this organization",
  };
}

/**
 * Copy for one operation's problem, keyed by `code`, else by the HTTP status. It wins over
 * `PROBLEM_COPY` because some backends answer a role or precondition failure with a generic code.
 */
export const OPERATION_PROBLEM_COPY: Readonly<
  Partial<Record<ConsoleOperation, Readonly<Record<string, ProblemCopy>>>>
> = {
  archiveMemory: { memory_internal_error: memorySearchNotEnabled("Archiving a memory") },
  archiveMemorySpace: { memory_internal_error: memorySearchNotEnabled("Archiving a space") },
  captureBrainDocument: {
    brain_permission_denied: {
      description:
        "Adding, archiving, tombstoning, or restoring a document needs a writer, curator, or owner grant on this Brain.",
      title: "Not allowed to change documents",
    },
  },
  createBrain: {
    internal_error: {
      description:
        "The slug may already be taken in this organization, or only owners and admins may create a company Brain.",
      title: "Brain not created",
    },
  },
  createBrainGrant: {
    brain_private_grant_invalid: {
      description: "A private Brain can be shared only with agents and service accounts.",
      title: "Grant not allowed",
    },
    internal_error: {
      description:
        "The target may already hold an active grant on this Brain, or the person, agent, or service account is not active.",
      title: "Grant not added",
    },
  },
  createBrainMount: {
    brain_agent_grant_required: {
      description: "Grant the deployment's agent access to the Brain in this environment first.",
      title: "Agent grant required",
    },
    internal_error: {
      description:
        "The deployment may already mount this Brain, or it is stopped or belongs to another agent.",
      title: "Mount not added",
    },
    validation_failed: {
      description: "A read-write mount needs a read-write agent grant.",
      title: "Mount not added",
    },
  },
  createBrainUploadTicket: { brain_permission_denied: UPLOAD_DENIED },
  createMemoryPolicy: { memory_internal_error: memorySearchNotEnabled("Saving a memory policy") },
  deleteMemory: { memory_internal_error: memorySearchNotEnabled("Deleting a memory") },
  eraseApp: { app_state_conflict: { title: "The app cannot be deleted yet" } },
  eraseBrain: {
    brain_version_conflict: {
      description:
        "The Brain changed after it was archived, so the version this page holds is stale. Someone may already have started erasing it.",
      title: "Brain changed",
    },
    idempotency_in_progress: {
      description:
        "An earlier attempt with this key is running or has started the erasure. The platform does not return its receipt, and the API lists no erasures, so the console cannot show it.",
      title: "Erasure already requested",
    },
  },
  getBrain: {
    brain_permission_denied: {
      description: "This is another member's private Brain. Only its owner can open it.",
      title: "Private Brain",
    },
  },
  getBrainUploadTicket: { brain_permission_denied: UPLOAD_DENIED },
  importMemories: { memory_internal_error: memorySearchNotEnabled("Importing memories") },
  listMemoryReviewItems: {
    insufficient_role: {
      description: "Only organization owners and admins can read the memory review queue.",
      title: "Your organization role does not permit this",
    },
  },
  refreshAppDomain: { domain_claimed: { title: "Another app verified this hostname" } },
  resolveBrainReviewItem: {
    brain_permission_denied: {
      description: "Resolving review items needs a writer, curator, or owner grant on this Brain.",
      title: "Not allowed to resolve review items",
    },
  },
  resolveMemoryReview: { memory_internal_error: memorySearchNotEnabled("Resolving a review") },
  restoreMemory: { memory_internal_error: memorySearchNotEnabled("Restoring a memory") },
  revokeBrainGrant: {
    validation_failed: {
      description: "A company Brain keeps at least one owner, and a private Brain keeps its owner.",
      title: "Grant not revoked",
    },
  },
  setAppPublication: { internal_error: { title: "Publication not changed yet" } },
  updateBrain: {
    internal_error: {
      description: "The slug may already be taken in this organization.",
      title: "Brain not updated",
    },
  },
  updateEnvironment: RENAME_CONFLICT,
  updateOrganization: {
    ...RENAME_CONFLICT,
    insufficient_role: {
      description: "Only an organization owner can rename the organization or change its slug.",
      title: "Owners only",
    },
  },
  updateProject: RENAME_CONFLICT,
  updateWorkspace: RENAME_CONFLICT,
  uploadBrainContent: { brain_permission_denied: UPLOAD_DENIED },
  upsertMemoryPolicy: { memory_internal_error: memorySearchNotEnabled("Saving a memory policy") },
};
