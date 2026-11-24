locals {
  name_prefix   = "api"
  jwt_audiences = try(tolist(jsondecode(trimspace(var.jwt_audience))), [trimspace(var.jwt_audience)])
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)

  # Platform bearer authentication intentionally remains in the application.
  # A gateway JWT authorizer would reject the opaque API keys that the same
  # tenancy and lifecycle routes support.
  api_functions = {
    tenancy = {
      function_name  = "api"
      handler        = "lambda-main.handler"
      route_keys     = ["$default"]
      route_prefixes = []
    }
    observability = {
      function_name  = "api-observability"
      handler        = "observability-api-main.handler"
      route_keys     = []
      route_prefixes = ["/v1/observability"]
    }
    governance = {
      function_name = "api-governance"
      handler       = "governance-api-main.handler"
      route_keys    = []
      route_prefixes = [
        "/v1/organizations/{id}/audit-exports",
        "/v1/organizations/{id}/data-exports",
        "/v1/organizations/{id}/erasures",
        "/v1/organizations/{id}/governance-operations",
        "/v1/organizations/{id}/retention-policy",
      ]
    }
    brain = {
      function_name  = "api-brain"
      handler        = "brain-api-main.handler"
      route_keys     = ["ANY /v1/mcp/brain"]
      route_prefixes = ["/v1/brains"]
    }
    evaluations = {
      function_name = "api-evaluations"
      handler       = "evaluation-api-main.handler"
      route_keys    = []
      route_prefixes = [
        "/v1/evaluation-runs",
        "/v1/regression-datasets",
        "/v1/release-comparisons",
        "/v1/score-definitions",
        "/v1/score-results",
        "/v1/traces",
      ]
    }
    system = {
      function_name  = "api-system"
      handler        = "system-api-main.handler"
      route_keys     = []
      route_prefixes = ["/v1/system"]
    }
    budget = {
      function_name  = "api-budget"
      handler        = "budget-api-main.handler"
      route_keys     = []
      route_prefixes = ["/v1/budgets"]
    }
    monitors = {
      function_name  = "api-monitors"
      handler        = "monitor-api-main.handler"
      route_keys     = []
      route_prefixes = ["/v1/alert-incidents", "/v1/alert-notification-preferences", "/v1/monitors"]
    }
    administration = {
      function_name = "api-administration"
      handler       = "administration-api-main.handler"
      route_keys    = []
      route_prefixes = [
        "/v1/connection-grants",
        "/v1/connection-verifications",
        "/v1/connections",
        "/v1/credential-references",
        "/v1/credentials",
        "/v1/extensions",
        "/v1/hosted-code-artifacts",
        "/v1/mcp-connections",
        "/v1/mcp-servers",
        "/v1/model-policies",
        "/v1/models",
        "/v1/oauth-apps",
        "/v1/providers",
        "/v1/tool-policies",
        "/v1/tools",
      ]
    }
  }

  # A prefix claims its whole subtree with two keys because a greedy path
  # variable never matches the bare prefix itself.
  api_routes = merge([
    for key, api in local.api_functions : merge(
      { for route_key in api.route_keys : route_key => key },
      { for prefix in api.route_prefixes : "ANY ${prefix}" => key },
      { for prefix in api.route_prefixes : "ANY ${prefix}/{proxy+}" => key },
    )
  ]...)

  runtime_routes = toset([
    "GET /v1/approvals",
    "GET /v1/artifacts",
    "GET /v1/artifacts/{artifactId}",
    "GET /v1/callback-dispatch-evidence/{evidenceId}",
    "GET /v1/channel-bindings",
    "GET /v1/channel-bindings/{bindingId}",
    "GET /v1/channel-deliveries",
    "GET /v1/end-users/erasures/{erasureId}",
    "GET /v1/heartbeats",
    "GET /v1/heartbeats/{heartbeatId}",
    "GET /v1/heartbeats/{heartbeatId}/fires",
    "GET /v1/previews/{previewId}",
    "GET /v1/runs",
    "GET /v1/runs/{runId}",
    "GET /v1/runs/{runId}/approvals/{approvalId}",
    "GET /v1/runs/{runId}/channel-deliveries/{deliveryId}",
    "GET /v1/runs/{runId}/logs",
    "GET /v1/runs/{runId}/tool-calls",
    "GET /v1/schedules",
    "GET /v1/schedules/{scheduleId}",
    "GET /v1/schedules/{scheduleId}/fires",
    "GET /v1/threads",
    "GET /v1/threads/{threadId}",
    "GET /v1/threads/{threadId}/erasures/{erasureId}",
    "GET /v1/threads/{threadId}/messages",
    "GET /v1/threads/{threadId}/runs/{runId}",
    "GET /v1/threads/{threadId}/runs/{runId}/message",
    "GET /v1/webhook-deliveries",
    "GET /v1/webhook-deliveries/{deliveryId}",
    "GET /v1/webhook-deliveries/{deliveryId}/attempts",
    "GET /v1/webhooks",
    "GET /v1/webhooks/{webhookId}",
    "GET /v1/workflow-executions",
    "GET /v1/workflow-executions/{workflowExecutionId}",
    "GET /v1/workflow-executions/{workflowExecutionId}/approvals/{workflowApprovalId}",
    "GET /v1/workflow-executions/{workflowExecutionId}/steps",
    "POST /v1/agent-deployments/{agentDeploymentId}/runs",
    "POST /v1/artifacts/{artifactId}/access-urls",
    "POST /v1/artifacts/{artifactId}/complete",
    "POST /v1/artifacts",
    "POST /v1/channel-bindings",
    "POST /v1/channel-bindings/{bindingId}/deliveries",
    "POST /v1/channel-bindings/{bindingId}/verify",
    "POST /v1/end-users/erasures",
    "PATCH /v1/artifacts/{artifactId}/retention",
    "POST /v1/heartbeats",
    "POST /v1/heartbeats/{heartbeatId}/fire",
    "POST /v1/heartbeats/{heartbeatId}/pause",
    "POST /v1/heartbeats/{heartbeatId}/resume",
    "POST /v1/previews",
    "POST /v1/previews/{previewId}/turns",
    "POST /v1/runs/search",
    "POST /v1/runs/{runId}/cancel",
    "POST /v1/runs/{runId}/replay",
    "POST /v1/runs/{runId}/retry",
    "POST /v1/runs/{runId}/approvals/{approvalId}/resolve",
    "POST /v1/runs/{runId}/tool-calls/{toolCallId}/results",
    "POST /v1/workflow-releases/{workflowReleaseId}/executions",
    "POST /v1/workflow-executions/{workflowExecutionId}/approvals/{workflowApprovalId}/resolve",
    "POST /v1/workflow-executions/{workflowExecutionId}/cancel",
    "POST /v1/schedules",
    "POST /v1/schedules/{scheduleId}/fire",
    "POST /v1/schedules/{scheduleId}/pause",
    "POST /v1/schedules/{scheduleId}/resume",
    "POST /v1/threads",
    "POST /v1/threads/{threadId}/archive",
    "POST /v1/threads/{threadId}/erasures",
    "POST /v1/threads/{threadId}/runs/{runId}/message/publication-releases",
    "POST /v1/threads/{threadId}/runs/{runId}/message/publication-reservations",
    "POST /v1/threads/{threadId}/runs/{runId}/message/publications",
    "POST /v1/threads/{threadId}/stream-sessions",
    "POST /v1/webhooks",
    "POST /v1/webhooks/{webhookId}/archive",
    "POST /v1/webhooks/{webhookId}/disable",
    "POST /v1/webhooks/{webhookId}/enable",
    "POST /v1/webhooks/{webhookId}/rotate-secret",
    "POST /v1/webhooks/{webhookId}/test",
    "POST /v1/webhook-deliveries/{deliveryId}/retry",
    "PATCH /v1/channel-bindings/{bindingId}",
    "PUT /v1/channel-bindings/{bindingId}/credential",
    "PATCH /v1/heartbeats/{heartbeatId}",
    "PATCH /v1/schedules/{scheduleId}",
    "PATCH /v1/webhooks/{webhookId}",
    "DELETE /v1/channel-bindings/{bindingId}",
    "DELETE /v1/channel-bindings/{bindingId}/credential",
    "DELETE /v1/heartbeats/{heartbeatId}",
    "DELETE /v1/artifacts/{artifactId}",
    "DELETE /v1/previews/{previewId}",
    "DELETE /v1/schedules/{scheduleId}",
  ])

  memory_routes = toset([
    "DELETE /v1/memory-space-grants/{grantId}",
    "DELETE /v1/memory-spaces/{memorySpaceId}",
    "GET /v1/memory",
    "GET /v1/memory-space-grants",
    "GET /v1/memory-spaces",
    "GET /v1/memory-spaces/{memorySpaceId}",
    "GET /v1/memory/flushes/{runId}",
    "GET /v1/memory/namespaces/readiness",
    "GET /v1/memory/policies",
    "GET /v1/memory/quality",
    "GET /v1/memory/review-items",
    "PATCH /v1/memory-space-grants/{grantId}",
    "POST /v1/memory-space-grants",
    "POST /v1/memory-spaces",
    "POST /v1/memory/active-recall",
    "POST /v1/memory/evidence/strategy-search",
    "POST /v1/memory/exports",
    "POST /v1/memory/flushes",
    "POST /v1/memory/imports",
    "POST /v1/memory/namespaces/prepare-full-text",
    "POST /v1/memory/policies",
    "POST /v1/memory/search",
    "POST /v1/memory/{memoryId}/archive",
    "POST /v1/memory/{memoryId}/delete",
    "POST /v1/memory/{memoryId}/restore",
    "POST /v1/memory/{memoryId}/review-items/{reviewId}",
    "POST /v1/memory/{memoryId}/retrievals/{retrievalId}/feedback",
    "PUT /v1/memory/policies",
  ])

  system_observer_routes = toset([
    "GET /v1/system/observer/alarms",
    "GET /v1/system/observer/components",
    "GET /v1/system/observer/deployments",
    "GET /v1/system/observer/installation",
    "GET /v1/system/observer/model-providers",
  ])
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }

}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.api_functions

  name              = "/aws/lambda/${each.value.function_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

moved {
  from = aws_cloudwatch_log_group.lambda
  to   = aws_cloudwatch_log_group.lambda["tenancy"]
}

resource "aws_security_group" "api" {
  count       = var.network == null ? 0 : 1
  name_prefix = "${local.name_prefix}-"
  description = "Network access for the platform API Brain query runtime"
  vpc_id      = var.network.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_security_group" "governance_worker" {
  count       = var.network == null ? 0 : 1
  name_prefix = "governance-worker-"
  description = "Network access for the governance worker"
  vpc_id      = var.network.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "governance_worker" {
  name              = "/aws/lambda/governance-worker"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${local.name_prefix}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "lambda" {
  name                 = local.name_prefix
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role" "governance_worker" {
  name                 = "governance-worker"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}
