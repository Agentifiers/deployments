locals {
  name_prefix     = "agent-runtime"
  iam_name_prefix = "agent-runtime"
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
  # The Fargate worker renews visibility at a third of this window, so a crashed
  # task's run returns to the queue within five minutes.
  agent_run_visibility_timeout_seconds = 300
  agent_run_redrive_max_receive_count  = 900
  # The workflow queue Lambda runs for up to 900 seconds; SQS requires at least that.
  workflow_queue_visibility_timeout_seconds = 5400
  # Six times the delivery worker's 120-second timeout, as Lambda recommends for SQS sources.
  # Normal retries set per-message visibility explicitly; this only bounds crash recovery.
  webhook_delivery_visibility_timeout_seconds = 720
  # Ten attempts, lease waits, and early redeliveries stay far below this; only messages that
  # keep failing processing are dead-lettered.
  webhook_delivery_redrive_max_receive_count = 30
  runtime_api_routes = toset([
    "GET /v1/artifacts/{artifactId}",
    "GET /v1/artifacts",
    "GET /v1/approvals",
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
    "GET /v1/runs/{runId}/channel-deliveries/{deliveryId}",
    "GET /v1/schedules",
    "GET /v1/schedules/{scheduleId}",
    "GET /v1/schedules/{scheduleId}/fires",
    "GET /v1/threads",
    "GET /v1/threads/{threadId}",
    "GET /v1/threads/{threadId}/erasures/{erasureId}",
    "GET /v1/threads/{threadId}/messages",
    "GET /v1/threads/{threadId}/runs/{runId}",
    "GET /v1/threads/{threadId}/runs/{runId}/message",
    "GET /v1/runs/{runId}/approvals/{approvalId}",
    "GET /v1/runs/{runId}/logs",
    "GET /v1/runs/{runId}/tool-calls",
    "GET /v1/workflow-executions/{executionId}",
    "GET /v1/workflow-executions/{executionId}/approvals/{approvalId}",
    "GET /v1/webhooks",
    "GET /v1/webhooks/{webhookId}",
    "GET /v1/workflow-executions",
    "GET /v1/workflow-executions/{executionId}/steps",
    "GET /v1/webhook-deliveries",
    "GET /v1/webhook-deliveries/{deliveryId}",
    "GET /v1/webhook-deliveries/{deliveryId}/attempts",
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
    "POST /v1/workflow-executions/{executionId}/approvals/{approvalId}/resolve",
    "POST /v1/workflow-executions/{executionId}/cancel",
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
    "PATCH /v1/heartbeats/{heartbeatId}",
    "PATCH /v1/schedules/{scheduleId}",
    "PATCH /v1/webhooks/{webhookId}",
    "PUT /v1/channel-bindings/{bindingId}/credential",
    "DELETE /v1/channel-bindings/{bindingId}",
    "DELETE /v1/channel-bindings/{bindingId}/credential",
    "DELETE /v1/heartbeats/{heartbeatId}",
    "DELETE /v1/artifacts/{artifactId}",
    "DELETE /v1/previews/{previewId}",
    "DELETE /v1/schedules/{scheduleId}",
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

resource "aws_sqs_queue" "dlq" {
  name                        = "${local.name_prefix}-dlq.fifo"
  fifo_queue                  = true
  message_retention_seconds   = 1209600
  sqs_managed_sse_enabled     = true
  content_based_deduplication = false
  tags                        = local.common_tags
}

resource "aws_sqs_queue" "runs" {
  name                       = "${local.name_prefix}.fifo"
  fifo_queue                 = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = local.agent_run_visibility_timeout_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = local.agent_run_redrive_max_receive_count
  })
  tags = local.common_tags
}


resource "aws_cloudwatch_log_group" "usage" {
  name              = "/aws/lambda/${local.name_prefix}-usage-materializer"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "artifact_retention" {
  name              = "/aws/lambda/${local.name_prefix}-artifact-retention"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "trace_finalization" {
  name              = "/aws/lambda/${local.name_prefix}-trace-finalization"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_prefix}-api"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "webhook_deliveries" {
  name              = "/aws/lambda/${local.name_prefix}-webhook-deliveries"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "webhook_events" {
  name              = "/aws/lambda/${local.name_prefix}-webhook-events"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "schedule_fire" {
  name              = "/aws/lambda/${local.name_prefix}-schedule-fire"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "heartbeat_fire" {
  name              = "/aws/lambda/${local.name_prefix}-heartbeat-fire"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "random_password" "stream_session" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "stream_session" {
  name        = "/${local.name_prefix}/stream-session-signing-key"
  description = "Signing key for public agent stream sessions."
  type        = "SecureString"
  value       = random_password.stream_session.result
  tags        = local.common_tags
}

resource "random_password" "end_user_subject_unprotected" {
  count   = var.deletion_protection_enabled ? 0 : 1
  length  = 64
  special = false
}

resource "random_password" "end_user_subject_protected" {
  count   = var.deletion_protection_enabled ? 1 : 0
  length  = 64
  special = false

  lifecycle { prevent_destroy = true }
}

resource "aws_ssm_parameter" "end_user_subject" {
  name        = "/${local.name_prefix}/end-user-subject-key"
  description = "HMAC key that derives pseudonymous end-user subject keys for threads."
  type        = "SecureString"
  value       = one(concat(random_password.end_user_subject_unprotected[*].result, random_password.end_user_subject_protected[*].result))
  tags        = local.common_tags
}

resource "aws_scheduler_schedule_group" "runtime" {
  name = "${local.name_prefix}-automations"
  tags = local.common_tags
}

resource "aws_security_group" "worker" {
  name_prefix = "${local.name_prefix}-"
  description = "Agent runtime Lambda egress to private services and AWS APIs"
  vpc_id      = var.vpc_id

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = merge(local.common_tags, { Name = local.name_prefix })
}

resource "aws_iam_role" "worker" {
  name                 = local.iam_name_prefix
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "worker" {
  dynamic "statement" {
    for_each = trimspace(var.oauth_refresh_function_arn) == "" ? [] : [1]
    content {
      sid       = "InvokeOAuthRefresh"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.oauth_refresh_function_arn]
    }
  }

  statement {
    sid       = "InvokeDocumentExtraction"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.document_extraction_function_arn]
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.api.arn}:*",
      "${aws_cloudwatch_log_group.client_tool_timeout.arn}:*",
      "${aws_cloudwatch_log_group.artifact_retention.arn}:*",
      "${aws_cloudwatch_log_group.heartbeat_fire.arn}:*",
      "${aws_cloudwatch_log_group.schedule_fire.arn}:*",
      "${aws_cloudwatch_log_group.trace_finalization.arn}:*",
      "${aws_cloudwatch_log_group.usage.arn}:*",
      "${aws_cloudwatch_log_group.webhook_deliveries.arn}:*",
      "${aws_cloudwatch_log_group.webhook_events.arn}:*",
      "${aws_cloudwatch_log_group.workflow_event_router.arn}:*",
      "${aws_cloudwatch_log_group.workflow_approval_timeout.arn}:*",
      "${aws_cloudwatch_log_group.workflow_queue.arn}:*",
    ]
  }

  statement {
    sid = "VpcNetworking"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]
  }

  statement {
    sid = "DynamoStreams"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]
    resources = [var.execution_table_stream_arn, var.usage_table_stream_arn]
  }

  statement {
    sid       = "ListDynamoStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "AdmitOrganizationRequests"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.request_admission_table_arn]
  }

  statement {
    sid       = "RunQueueEnqueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn]
  }

  statement {
    sid = "WorkflowQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.workflow.arn]
  }

  statement {
    sid     = "RuntimeFailureQueues"
    actions = ["sqs:SendMessage"]
    resources = [
      aws_sqs_queue.artifact_retention_failures.arn,
      aws_sqs_queue.automation_failures.arn,
      aws_sqs_queue.trace_finalization_failures.arn,
      aws_sqs_queue.usage_failures.arn,
      aws_sqs_queue.webhook_event_failures.arn,
      aws_sqs_queue.workflow_event_failures.arn,
    ]
  }

  statement {
    sid = "WebhookDeliveryQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.webhook_deliveries.arn]
  }

  statement {
    sid = "PlatformTables"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = concat(
      values(var.dynamodb_table_arns),
      [for arn in values(var.dynamodb_table_arns) : "${arn}/index/*"],
    )
  }

  statement {
    sid = "MessageBodies"
    actions = [
      "s3:DeleteObjectVersion",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = flatten([
      for bucket_arn in concat([var.artifact_bucket_arn], var.legacy_artifact_bucket_arns) : [
        "${bucket_arn}/artifacts/*",
        "${bucket_arn}/memory/*",
        "${bucket_arn}/message-bodies/*",
        "${bucket_arn}/organizations/*",
      ]
    ])
  }

  statement {
    sid       = "BrowserSessionIdempotency"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.artifact_bucket_arn}/browser-session-idempotency/*"]
  }

  statement {
    sid       = "ArtifactBucket"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketVersions"]
    resources = concat([var.artifact_bucket_arn], var.legacy_artifact_bucket_arns)
  }

  # Artifact objects are SSE-KMS under the shared key; S3 uses it on the caller's behalf.
  statement {
    sid       = "ArtifactObjectEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"]
    }
  }

  # The credential vault is the only direct KMS API consumer.
  statement {
    sid       = "ProtectCredentials"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["credentialId", "environmentId", "organizationId", "ownerId", "ownerType", "projectId", "purpose"]
    }

    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:credentialId"
      values   = ["false"]
    }
  }

  statement {
    sid     = "RuntimeParameters"
    actions = ["ssm:GetParameter"]
    resources = concat([
      aws_ssm_parameter.end_user_subject.arn,
      aws_ssm_parameter.stream_session.arn,
      var.durable_streams_auth_secret_arn,
      var.model_grants_parameter_arn,
    ], [for arn in var.runtime_secret_arns : arn if strcontains(arn, ":ssm:")])
  }

  # Workflow and client-tool-timeout Lambdas build the full worker dependencies and run
  # runtime tools (Brain query, memory recall) with agent-worker service tokens. Run
  # tokens stay with the Fargate worker, which holds the run leases.
  statement {
    sid       = "InvokeAgentWorkerModelTokenIssuer"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.model_token_issuer["agent-worker"].arn]
  }

  dynamic "statement" {
    for_each = length(concat(
      var.legacy_webhook_signing_secret_arns,
      [for arn in var.runtime_secret_arns : arn if strcontains(arn, ":secretsmanager:")],
    )) == 0 ? [] : [1]
    content {
      sid     = "ExternallyManagedSecrets"
      actions = ["secretsmanager:GetSecretValue"]
      resources = concat(
        var.legacy_webhook_signing_secret_arns,
        [for arn in var.runtime_secret_arns : arn if strcontains(arn, ":secretsmanager:")],
      )
    }
  }

  statement {
    sid = "AutomationSchedules"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
      "scheduler:UpdateSchedule",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:scheduler:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:schedule/${aws_scheduler_schedule_group.runtime.name}/*"]
  }

  statement {
    sid       = "PassSchedulerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]
  }
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${local.iam_name_prefix}-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.client_tool_timeout.arn,
      aws_lambda_function.heartbeat_fire.arn,
      aws_lambda_function.schedule_fire.arn,
      aws_lambda_function.workflow_approval_timeout.arn,
    ]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.automation_failures.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.name_prefix}-invoke"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "${local.name_prefix}-runtime"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy_attachment" "worker_runtime" {
  for_each = var.runtime_policy_arns

  role       = aws_iam_role.worker.name
  policy_arn = each.value
}

resource "aws_lambda_function" "usage" {
  function_name = "${local.name_prefix}-usage-materializer"
  role          = aws_iam_role.worker.arn
  handler       = "usage-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    # The materializer reads each organization's effective operator-funded spend ceiling.
    variables = merge({
      DEPLOYMENTS_AI_CONTROL_TABLE         = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE          = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE       = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS = var.tenant_limit_defaults_json
      DEPLOYMENTS_AI_USAGE_TABLE           = var.dynamodb_table_names["usage"]
      }, var.default_model_spend_ceiling_usd_micros == null ? {} : {
      DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS = tostring(var.default_model_spend_ceiling_usd_micros)
    })
  }

  depends_on = [aws_cloudwatch_log_group.usage, aws_iam_role_policy.worker]
  tags       = local.common_tags
}

resource "aws_lambda_function" "artifact_retention" {
  function_name = "${local.name_prefix}-artifact-retention"
  role          = aws_iam_role.worker.arn
  handler       = "artifact-retention-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  depends_on = [aws_cloudwatch_log_group.artifact_retention, aws_iam_role_policy.worker]
  tags       = local.common_tags
}

resource "aws_lambda_function" "trace_finalization" {
  function_name = "${local.name_prefix}-trace-finalization"
  role          = aws_iam_role.worker.arn
  handler       = "trace-finalization-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_CONTROL_TABLE        = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVALUATION_QUEUE_URL = aws_sqs_queue.evaluations.url
      DEPLOYMENTS_AI_EVENTS_TABLE         = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE      = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE          = var.dynamodb_table_names["usage"]
    }
  }

  depends_on = [aws_cloudwatch_log_group.trace_finalization, aws_iam_role_policy.evaluations, aws_iam_role_policy.worker]
  tags       = local.common_tags
}

locals {
  agent_worker_ignored_environment_aliases = toset([
    "DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET",
  ])
  # Only the ECS worker issues Brain upload tickets, so the 4 KB-capped Lambdas
  # that share agent_worker_environment go without the upload quotas. They also
  # go without the MicroVM execution role, log group, and image capacity, so
  # MicroVMs they start run without a role, their runtime logs are not
  # forwarded to CloudWatch, and they reserve the default capacity.
  agent_worker_container_only_environment_names = toset([
    "DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS",
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_MEMORY_MIB",
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VCPU",
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_LOG_GROUP",
  ])
  agent_worker_environment = merge({
    DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL                  = aws_sqs_queue.runs.url
    DEPLOYMENTS_AI_AGENT_RUN_MAX_RECEIVE_COUNT          = tostring(local.agent_run_redrive_max_receive_count)
    DEPLOYMENTS_AI_AGENT_RUN_VISIBILITY_TIMEOUT_SECONDS = tostring(local.agent_run_visibility_timeout_seconds)
    DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN         = aws_sqs_queue.automation_failures.arn
    DEPLOYMENTS_AI_CLIENT_TOOL_TIMEOUT_LAMBDA_ARN       = local.client_tool_timeout_function_arn
    DEPLOYMENTS_AI_ARTIFACT_BUCKET                      = var.artifact_bucket_name
    DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON         = jsonencode(var.legacy_artifact_bucket_names)
    DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN                 = var.data_kms_key_arn
    DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL               = var.model_gateway_base_url
    DEPLOYMENTS_AI_MODEL_GATEWAY_RUN_TOKEN_ISSUER       = aws_lambda_function.model_token_issuer["run"].function_name
    DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER           = aws_lambda_function.model_token_issuer["agent-worker"].function_name
    DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN           = var.model_grants_parameter_arn
    DEPLOYMENTS_AI_CONTROL_TABLE                        = var.dynamodb_table_names["control"]
    DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN               = var.data_kms_key_arn
    DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN      = var.durable_streams_auth_secret_arn
    DEPLOYMENTS_AI_DURABLE_STREAMS_URL                  = var.durable_streams_base_url
    DEPLOYMENTS_AI_EVALUATION_QUEUE_URL                 = aws_sqs_queue.evaluations.url
    DEPLOYMENTS_AI_EVENTS_TABLE                         = var.dynamodb_table_names["events"]
    DEPLOYMENTS_AI_EXECUTION_TABLE                      = var.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_HEARTBEAT_FIRE_LAMBDA_ARN            = aws_lambda_function.heartbeat_fire.arn
    DEPLOYMENTS_AI_MCP_REQUEST_TIMEOUT_MS               = "60000"
    DEPLOYMENTS_AI_SCHEDULE_FIRE_LAMBDA_ARN             = aws_lambda_function.schedule_fire.arn
    DEPLOYMENTS_AI_SCHEDULER_GROUP                      = aws_scheduler_schedule_group.runtime.name
    DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN                   = aws_iam_role.scheduler.arn
    DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS                = var.tenant_limit_defaults_json
    DEPLOYMENTS_AI_USAGE_TABLE                          = var.dynamodb_table_names["usage"]
    }, trimspace(var.oauth_refresh_function_name) == "" ? {} : {
    DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME = var.oauth_refresh_function_name
    }, {
    for name, value in var.runtime_environment_variables : name => value
    if !contains(setunion(local.agent_worker_ignored_environment_aliases, local.agent_worker_container_only_environment_names), name)
  })
  # Lambda's reported quota measurement matches the UTF-8 byte length of the
  # compact JSON environment map. Base64 exposes bytes rather than HCL characters.
  agent_worker_environment_base64 = base64encode(jsonencode(local.agent_worker_environment))
  agent_worker_environment_size_bytes = floor(
    length(local.agent_worker_environment_base64) * 3 / 4
  ) - length(regexall("=", local.agent_worker_environment_base64))
  fire_runtime_environment = {
    DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL             = aws_sqs_queue.runs.url
    DEPLOYMENTS_AI_CONTROL_TABLE                   = var.dynamodb_table_names["control"]
    DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN = var.durable_streams_auth_secret_arn
    DEPLOYMENTS_AI_DURABLE_STREAMS_URL             = var.durable_streams_base_url
    DEPLOYMENTS_AI_EVENTS_TABLE                    = var.dynamodb_table_names["events"]
    DEPLOYMENTS_AI_EXECUTION_TABLE                 = var.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_USAGE_TABLE                     = var.dynamodb_table_names["usage"]
  }
  public_runtime_environment = merge(local.fire_runtime_environment, {
    DEPLOYMENTS_AI_ARTIFACT_BUCKET                   = var.artifact_bucket_name
    DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON      = jsonencode(var.legacy_artifact_bucket_names)
    DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN              = var.data_kms_key_arn
    DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN            = var.data_kms_key_arn
    DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME = var.document_extraction_function_name
    DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN      = aws_sqs_queue.automation_failures.arn
    DEPLOYMENTS_AI_HEARTBEAT_FIRE_LAMBDA_ARN         = aws_lambda_function.heartbeat_fire.arn
    DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN          = aws_ssm_parameter.end_user_subject.arn
    DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN        = var.model_grants_parameter_arn
    DEPLOYMENTS_AI_SCHEDULE_FIRE_LAMBDA_ARN          = aws_lambda_function.schedule_fire.arn
    DEPLOYMENTS_AI_SCHEDULER_GROUP                   = aws_scheduler_schedule_group.runtime.name
    DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN                = aws_iam_role.scheduler.arn
    DEPLOYMENTS_AI_STREAM_GATEWAY_BASE_URL           = var.stream_gateway_base_url
    DEPLOYMENTS_AI_STREAM_SESSION_SECRET_ARN         = aws_ssm_parameter.stream_session.arn
    DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE           = var.request_admission_table_name
    DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS             = var.tenant_limit_defaults_json
    DEPLOYMENTS_AI_WEBHOOK_DELIVERY_QUEUE_URL        = aws_sqs_queue.webhook_deliveries.url
    # Human platform bearer JWTs are verified with the platform API's issuer, audience, and profile.
    }, trimspace(var.api_jwt_issuer) == "" ? {} : {
    DEPLOYMENTS_AI_API_JWT_AUDIENCE      = var.api_jwt_audience
    DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE = var.api_jwt_claim_profile
    DEPLOYMENTS_AI_API_JWT_ISSUER        = var.api_jwt_issuer
    }, var.default_model_spend_ceiling_usd_micros == null ? {} : {
    DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS = tostring(var.default_model_spend_ceiling_usd_micros)
  })
}
