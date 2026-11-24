locals {
  name_prefix = "memory"
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
  workers      = toset(["memory-cleanup", "memory-flush", "memory-index", "memory-operation", "memory-reconcile", "memory-search-placement", "memory-shadow", "memory-usage"])
  blob_readers = toset(["memory-api", "memory-cleanup", "memory-flush", "memory-index", "memory-shadow"])
  queue_visibility_timeouts = {
    memory-cleanup          = 1800
    memory-flush            = 1800
    memory-index            = 720
    memory-operation        = 1020
    memory-reconcile        = 1800
    memory-search-placement = 1800
    memory-shadow           = 180
    memory-usage            = 180
  }
  # An index job spends up to two receives per attempt (the failure and a wait for its retry), and
  # transient conflicts add receives that consume no attempt. The job's own attempt budget ends real
  # failures, so only a message that keeps failing for hours reaches the dead-letter queue.
  index_redrive_max_receive_count = 50
  functions = {
    memory-cleanup = {
      handler = "cleanup-worker.handler"
      timeout = 300
    }
    memory-erasure = {
      handler = "erasure-worker.handler"
      timeout = 840
    }
    memory-api = {
      handler = "api.handler"
      timeout = 30
    }
    memory-flush = {
      handler = "flush-worker.handler"
      timeout = 300
    }
    memory-index = {
      handler = "index-worker.handler"
      timeout = 120
    }
    memory-index-dispatch = {
      handler = "index-dispatcher.handler"
      timeout = 30
    }
    memory-operation = {
      handler = "operation-worker.handler"
      timeout = 900
    }
    memory-operation-reconcile = {
      handler = "operation-reconciler.handler"
      timeout = 300
    }
    memory-reconcile = {
      handler = "reconcile.handler"
      timeout = 300
    }
    # Provisions each new organization's default search target on organization.created.
    memory-search-placement = {
      handler = "search-placement-worker.handler"
      timeout = 300
    }
    memory-shadow = {
      handler = "shadow-worker.handler"
      timeout = 30
    }
    memory-usage = {
      handler = "usage-worker.handler"
      timeout = 30
    }
  }
  api_routes = toset([
    "DELETE /v1/memory-space-grants/{grantId}",
    "DELETE /v1/memory-spaces/{memorySpaceId}",
    "GET /v1/memory",
    "GET /v1/memory-space-grants",
    "GET /v1/memory-spaces",
    "GET /v1/memory-spaces/{memorySpaceId}",
    "GET /v1/memory/flushes/{runId}",
    "GET /v1/memory/policies",
    "GET /v1/memory/quality",
    "GET /v1/memory/namespaces/readiness",
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
  reconciliation_scope_map = {
    for scope in var.reconciliation_scopes :
    "${scope.organization_id}-${scope.project_id}-${scope.environment_id}-${coalesce(scope.workspace_id, "environment")}" => scope
  }
  memory_membership_keyring = var.membership_keyring == null ? {
    currentVersion = 1
    keys = {
      "1" = random_password.memory_membership.result
    }
    } : {
    currentVersion = var.membership_keyring.current_version
    keys           = var.membership_keyring.keys
  }
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

resource "random_password" "memory_membership" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "memory_membership" {
  name        = "/${local.name_prefix}/membership-hmac-key"
  description = "HMAC key for pseudonymous memory search target membership receipts."
  type        = "SecureString"
  value       = jsonencode(local.memory_membership_keyring)
  tags        = local.common_tags
}

data "aws_iam_policy_document" "eventbridge_queue" {
  for_each = { for name, rule in aws_cloudwatch_event_rule.queue : name => rule if name != "memory-index" }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runtime[each.key].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [each.value.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "eventbridge" {
  for_each  = data.aws_iam_policy_document.eventbridge_queue
  queue_url = aws_sqs_queue.runtime[each.key].url
  policy    = each.value.json
}

data "aws_iam_policy_document" "eventbridge_dlq" {
  for_each = aws_cloudwatch_event_rule.queue
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [each.key == "memory-index" ? aws_sqs_queue.memory_index_eventbridge_dlq.arn : aws_sqs_queue.dlq[each.key].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = each.key == "memory-reconcile" ? concat(
        [each.value.arn],
        [for rule in aws_cloudwatch_event_rule.reconcile : rule.arn]
      ) : [each.value.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "eventbridge_dlq" {
  for_each  = data.aws_iam_policy_document.eventbridge_dlq
  queue_url = each.key == "memory-index" ? aws_sqs_queue.memory_index_eventbridge_dlq.url : aws_sqs_queue.dlq[each.key].url
  policy    = each.value.json
}

resource "aws_security_group" "runtime" {
  count = var.network == null ? 0 : 1

  name_prefix = "${local.name_prefix}-"
  description = "Memory Lambda egress to private Bifrost, OpenSearch, and AWS APIs"
  vpc_id      = var.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "runtime" {
  for_each          = local.functions
  name              = "/aws/lambda/${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "runtime" {
  for_each             = local.functions
  name                 = each.key
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "runtime" {
  for_each = local.functions

  statement {
    sid = "MemoryTables"
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

  dynamic "statement" {
    for_each = contains(["memory-api", "memory-flush", "memory-index", "memory-operation", "memory-shadow"], each.key) ? [1] : []
    content {
      sid       = "InvokeModelTokenIssuer"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.model_gateway_token_issuer.arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "memory-api" ? [1] : []
    content {
      sid       = "AdmitOrganizationRequests"
      actions   = ["dynamodb:UpdateItem"]
      resources = [var.request_admission_table_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "memory-index-dispatch" ? [1] : []
    content {
      sid     = "DispatchTargetOrderedMemoryIndex"
      actions = ["sqs:SendMessage"]
      resources = [
        aws_sqs_queue.runtime["memory-index"].arn,
        aws_sqs_queue.memory_index_eventbridge_dlq.arn,
      ]
    }
  }

  dynamic "statement" {
    for_each = each.key == "memory-operation-reconcile" ? [1] : []
    content {
      sid     = "DispatchDueMemorySearchWork"
      actions = ["sqs:SendMessage"]
      resources = [
        aws_sqs_queue.runtime["memory-index"].arn,
        aws_sqs_queue.runtime["memory-operation"].arn,
      ]
    }
  }

  dynamic "statement" {
    for_each = each.key == "memory-search-placement" ? [1] : []
    content {
      sid       = "DispatchDefaultMemorySearchProvisioning"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.runtime["memory-operation"].arn]
    }
  }

  dynamic "statement" {
    for_each = var.aws_native_enabled && contains(["memory-api", "memory-erasure", "memory-index", "memory-operation", "memory-shadow", "memory-reconcile"], each.key) ? [1] : []
    content {
      sid       = "AwsNativeOpenSearch"
      actions   = ["es:ESHttpDelete", "es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut"]
      resources = local.opensearch_index_resources
    }
  }

  dynamic "statement" {
    for_each = var.aws_native_enabled && contains(["memory-erasure", "memory-operation"], each.key) ? [1] : []
    content {
      sid       = "AwsNativeOpenSearchPurgeStatus"
      actions   = ["es:ESHttpGet"]
      resources = concat(local.opensearch_task_resources, local.opensearch_snapshot_resources)
    }
  }

  dynamic "statement" {
    for_each = var.aws_native_enabled && contains(["memory-erasure", "memory-operation"], each.key) ? [1] : []
    content {
      sid       = "AwsNativeOpenSearchPurgeTaskCleanup"
      actions   = ["es:ESHttpDelete"]
      resources = local.opensearch_task_result_resources
    }
  }

  dynamic "statement" {
    for_each = contains(["memory-erasure", "memory-operation", "memory-search-placement"], each.key) ? [1] : []
    content {
      sid       = "MemoryMembershipSecret"
      actions   = ["ssm:GetParameter"]
      resources = [aws_ssm_parameter.memory_membership.arn]
    }
  }

  dynamic "statement" {
    for_each = contains(local.blob_readers, each.key) ? [1] : []
    content {
      sid     = "ReadMemoryBlobs"
      actions = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = flatten([
        for bucket_arn in concat([var.blob_bucket_arn], var.legacy_blob_bucket_arns) : concat(
          ["${bucket_arn}/memory/*"],
          each.key == "memory-flush" ? ["${bucket_arn}/messages/*"] : [],
        )
      ])
    }
  }

  dynamic "statement" {
    for_each = contains(["memory-api", "memory-shadow"], each.key) ? [1] : []
    content {
      sid       = "DispatchMemoryWork"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.runtime["memory-usage"].arn]
    }
  }

  dynamic "statement" {
    for_each = contains(["memory-api", "memory-reconcile"], each.key) ? [1] : []
    content {
      sid       = "MemoryPageCursors"
      actions   = ["kms:Decrypt", "kms:Encrypt"]
      resources = [var.data_kms_key_arn]
      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:purpose"
        values   = ["memory-page-cursor"]
      }
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "kms:EncryptionContextKeys"
        values   = ["purpose"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "memory-cleanup" ? [1] : []
    content {
      sid     = "DeleteMemoryBlobs"
      actions = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = [
        for bucket_arn in concat([var.blob_bucket_arn], var.legacy_blob_bucket_arns) : "${bucket_arn}/memory/*"
      ]
    }
  }

  dynamic "statement" {
    for_each = each.key == "memory-cleanup" ? [1] : []
    content {
      sid       = "ListMemoryBlobVersions"
      actions   = ["s3:ListBucketVersions"]
      resources = concat([var.blob_bucket_arn], var.legacy_blob_bucket_arns)
    }
  }

  dynamic "statement" {
    for_each = contains(local.blob_readers, each.key) ? [1] : []
    content {
      sid       = "DecryptMemoryBlobs"
      actions   = ["kms:Decrypt"]
      resources = [var.data_kms_key_arn]
      # Blob objects are SSE-KMS under the shared data key; only S3 may use it on their behalf.
      condition {
        test     = "StringLike"
        variable = "kms:ViaService"
        values   = ["s3.*.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = contains(local.workers, each.key) ? [1] : []
    content {
      sid = "ConsumeMemoryQueue"
      actions = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
      ]
      resources = [aws_sqs_queue.runtime[each.key].arn]
    }
  }

  dynamic "statement" {
    for_each = var.network == null ? [] : [1]
    content {
      sid = "VpcNetworking"
      actions = [
        "ec2:AssignPrivateIpAddresses",
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:UnassignPrivateIpAddresses",
      ]
      resources = ["*"]
    }
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runtime[each.key].arn}:*"]
  }
}

resource "aws_iam_role_policy" "runtime" {
  for_each = data.aws_iam_policy_document.runtime
  name     = "memory-runtime"
  role     = aws_iam_role.runtime[each.key].id
  policy   = each.value.json
}

resource "aws_lambda_function" "runtime" {
  for_each = local.functions

  function_name     = each.key
  architectures     = ["arm64"]
  handler           = each.value.handler
  memory_size       = each.key == "memory-flush" ? 1024 : 512
  role              = aws_iam_role.runtime[each.key].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = each.value.timeout

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge({
      DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS   = join(",", var.model_gateway_fallback_ids)
      DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL       = var.model_gateway_base_url
      DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER   = var.model_gateway_token_issuer.function_name
      DEPLOYMENTS_AI_CONTROL_TABLE                = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE                 = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE              = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS  = tostring(var.embedding_dimensions)
      DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL       = var.embedding_model
      DEPLOYMENTS_AI_MEMORY_RERANK_MODEL          = var.rerank_model
      DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES         = jsonencode(var.jwt_audience)
      DEPLOYMENTS_AI_MEMORY_JWT_ISSUER            = var.jwt_issuer
      DEPLOYMENTS_AI_MEMORY_JWKS_URI              = var.jwt_jwks_uri
      DEPLOYMENTS_AI_MEMORY_BLOB_BUCKET           = var.blob_bucket_name
      DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = jsonencode(var.legacy_blob_bucket_names)
      DEPLOYMENTS_AI_MEMORY_CURSOR_KMS_KEY_ARN    = var.data_kms_key_arn
      DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_SECRET_ARN = aws_ssm_parameter.memory_membership.arn
      DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT   = var.aws_native_enabled ? var.opensearch_endpoint : ""
      DEPLOYMENTS_AI_STAGE                        = var.environment
      DEPLOYMENTS_AI_MEMORY_USAGE_QUEUE_URL       = aws_sqs_queue.runtime["memory-usage"].url
      DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL       = aws_sqs_queue.runtime["memory-index"].url
      DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL   = aws_sqs_queue.runtime["memory-operation"].url
      DEPLOYMENTS_AI_USAGE_TABLE                  = var.dynamodb_table_names["usage"]
      }, each.key == "memory-api" ? {
      DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE = var.request_admission_table_name
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS   = var.tenant_limit_defaults_json
      } : {}, each.key == "memory-api" && var.default_model_spend_ceiling_usd_micros != null ? {
      DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS = tostring(var.default_model_spend_ceiling_usd_micros)
      } : {}, each.key == "memory-flush" && var.flush_model != null ? {
      DEPLOYMENTS_AI_MEMORY_FLUSH_MODEL = var.flush_model
    } : {})
  }

  dynamic "vpc_config" {
    for_each = var.network == null ? [] : [var.network]
    content {
      security_group_ids = [aws_security_group.runtime[0].id]
      subnet_ids         = vpc_config.value.private_subnet_ids
    }
  }

  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_lambda_event_source_mapping" "worker" {
  for_each = local.workers

  event_source_arn        = aws_sqs_queue.runtime[each.key].arn
  function_name           = aws_lambda_function.runtime[each.key].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = lookup({
      memory-flush     = 2
      memory-index     = var.index_worker_maximum_concurrency
      memory-reconcile = 2
    }, each.key, 10)
  }
}

resource "aws_apigatewayv2_api" "memory" {
  name          = local.name_prefix
  protocol_type = "HTTP"
  tags          = local.common_tags
}

resource "aws_apigatewayv2_integration" "memory" {
  api_id                 = aws_apigatewayv2_api.memory.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.runtime["memory-api"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "memory" {
  for_each = local.api_routes

  api_id             = aws_apigatewayv2_api.memory.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.memory.id}"
}

resource "aws_apigatewayv2_stage" "memory" {
  api_id      = aws_apigatewayv2_api.memory.id
  name        = "$default"
  auto_deploy = true
  tags        = local.common_tags
}

resource "aws_lambda_permission" "memory_api" {
  statement_id  = "AllowMemoryApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.runtime["memory-api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.memory.execution_arn}/*/*"
}

resource "aws_cloudwatch_event_rule" "reconcile" {
  for_each = local.reconciliation_scope_map

  name                = "${local.name_prefix}-reconcile-${substr(sha256(each.key), 0, 10)}"
  schedule_expression = "rate(5 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "reconcile" {
  for_each = aws_cloudwatch_event_rule.reconcile

  rule      = each.value.name
  target_id = "memory-reconcile"
  arn       = aws_lambda_function.runtime["memory-reconcile"].arn
  input = jsonencode({
    environmentId  = local.reconciliation_scope_map[each.key].environment_id
    organizationId = local.reconciliation_scope_map[each.key].organization_id
    projectId      = local.reconciliation_scope_map[each.key].project_id
    workspaceId    = try(local.reconciliation_scope_map[each.key].workspace_id, null)
  })
  dead_letter_config {
    arn = aws_sqs_queue.dlq["memory-reconcile"].arn
  }
  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_sqs_queue_policy.eventbridge_dlq]
}

resource "aws_lambda_permission" "reconcile" {
  for_each = aws_cloudwatch_event_rule.reconcile

  statement_id  = "AllowMemoryReconcile${substr(sha256(each.key), 0, 12)}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.runtime["memory-reconcile"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}
