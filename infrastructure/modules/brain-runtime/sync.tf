resource "aws_sqs_queue" "sync_dlq" {
  name                        = "${local.name_prefix}-sync-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
  tags                        = local.common_tags
}

resource "aws_sqs_queue" "sync_dispatcher_dlq" {
  name                      = "${local.name_prefix}-sync-dispatch-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "sync" {
  name                        = "${local.name_prefix}-sync.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 345600
  visibility_timeout_seconds  = 900
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sync_dlq.arn
    maxReceiveCount     = 5
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "sync_runtime" {
  for_each          = toset(["brain-sync-dispatch", "brain-sync-worker"])
  name              = "/aws/lambda/${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "sync_runtime" {
  for_each             = aws_cloudwatch_log_group.sync_runtime
  name                 = each.key
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "sync_runtime" {
  for_each = aws_iam_role.sync_runtime
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.sync_runtime[each.key].arn}:*"]
  }
  statement {
    sid = "BrainTables"
    actions = each.key == "brain-sync-dispatch" ? [
      "dynamodb:Query",
      ] : [
      "dynamodb:ConditionCheckItem",
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
    for_each = each.key == "brain-sync-dispatch" ? [1] : []
    content {
      sid       = "DispatchBrainSync"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.sync.arn, aws_sqs_queue.sync_dispatcher_dlq.arn]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-sync-worker" ? [1] : []
    content {
      sid       = "ConsumeBrainSync"
      actions   = ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
      resources = [aws_sqs_queue.sync.arn]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-sync-worker" ? [1] : []
    content {
      sid       = "WriteBrainEvidence"
      actions   = ["s3:PutObject"]
      resources = ["${var.content_bucket_arn}/organizations/*/brains/*"]
    }
  }
  statement {
    sid       = "Encryption"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]
    # Evidence objects are SSE-KMS under the shared data key; only S3 may use it on their behalf.
    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values   = ["s3.*.amazonaws.com"]
    }
  }
  # The worker only reads GitHub OAuth tokens from the credential vault, whose envelopes share
  # the platform data key with other purposes; the context pins the vault entry kind.
  dynamic "statement" {
    for_each = each.key == "brain-sync-worker" ? [1] : []
    content {
      sid       = "ReadProviderOAuthCredentials"
      actions   = ["kms:Decrypt"]
      resources = [var.data_kms_key_arn]
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "kms:EncryptionContextKeys"
        values   = ["credentialId", "environmentId", "organizationId", "ownerId", "ownerType", "projectId", "purpose"]
      }
      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:purpose"
        values   = ["provider-oauth-token"]
      }
      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:ownerType"
        values   = ["provider-connection"]
      }
    }
  }
}

resource "aws_iam_role_policy" "sync_runtime" {
  for_each = data.aws_iam_policy_document.sync_runtime
  name     = "brain-sync-runtime"
  role     = aws_iam_role.sync_runtime[each.key].id
  policy   = each.value.json
}

resource "aws_lambda_function" "sync_dispatcher" {
  function_name     = "${local.name_prefix}-sync-dispatch"
  architectures     = ["arm64"]
  handler           = "brain-sync-dispatcher-main.handler"
  memory_size       = 512
  role              = aws_iam_role.sync_runtime["brain-sync-dispatch"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 60
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = {
      DEPLOYMENTS_AI_BRAIN_SYNC_QUEUE_URL = aws_sqs_queue.sync.url
      DEPLOYMENTS_AI_CONTROL_TABLE        = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE         = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE      = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE          = var.dynamodb_table_names["usage"]
    }
  }
  depends_on = [aws_cloudwatch_log_group.sync_runtime, aws_iam_role_policy.sync_runtime]
  tags       = local.common_tags
}

resource "aws_lambda_function" "sync_worker" {
  function_name     = "${local.name_prefix}-sync-worker"
  architectures     = ["arm64"]
  handler           = "brain-sync-worker-main.handler"
  memory_size       = 2048
  role              = aws_iam_role.sync_runtime["brain-sync-worker"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 840
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = merge({
      DEPLOYMENTS_AI_ARTIFACT_BUCKET        = var.content_bucket_name
      DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN   = var.data_kms_key_arn
      DEPLOYMENTS_AI_CONTROL_TABLE          = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN = var.data_kms_key_arn
      DEPLOYMENTS_AI_EVENTS_TABLE           = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE        = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE            = var.dynamodb_table_names["usage"]
    }, local.upload_quotas_environment)
  }
  depends_on = [aws_cloudwatch_log_group.sync_runtime, aws_iam_role_policy.sync_runtime]
  tags       = local.common_tags
}

resource "aws_lambda_event_source_mapping" "sync" {
  event_source_arn        = aws_sqs_queue.sync.arn
  function_name           = aws_lambda_function.sync_worker.arn
  batch_size              = 1
  enabled                 = true
  function_response_types = ["ReportBatchItemFailures"]
}

# Only managed sources commit an initial sync job with the source, and only their
# brain-source.created events carry its identity. Upload and other unmanaged
# sources announce no sync job, so the dispatcher must never receive them.
resource "aws_cloudwatch_event_rule" "sync_created" {
  name           = "${local.name_prefix}-sync-created"
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source        = ["deployments-ai.platform"]
    "detail-type" = ["brain-source.created"]
    detail = {
      payload = {
        syncJobIdempotencyKey = [{ exists = true }]
      }
    }
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "sync_created" {
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.sync_created.name
  arn            = aws_lambda_function.sync_dispatcher.arn
  target_id      = "brain-sync-dispatch"
  dead_letter_config { arn = aws_sqs_queue.sync_dispatcher_dlq.arn }
}

resource "aws_lambda_permission" "sync_created" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sync_dispatcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sync_created.arn
  statement_id  = "AllowBrainSyncCreated"
}

resource "aws_cloudwatch_event_rule" "sync_sweep" {
  name                = "${local.name_prefix}-sync-sweep"
  schedule_expression = "rate(5 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "sync_sweep" {
  arn   = aws_lambda_function.sync_dispatcher.arn
  input = jsonencode({ kind = "brain-sync-dispatch-sweep" })
  rule  = aws_cloudwatch_event_rule.sync_sweep.name
}

resource "aws_lambda_permission" "sync_sweep" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sync_dispatcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sync_sweep.arn
  statement_id  = "AllowBrainSyncSweep"
}

data "aws_iam_policy_document" "sync_eventbridge_dlq" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.sync_dispatcher_dlq.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.sync_created.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "sync_eventbridge_dlq" {
  queue_url = aws_sqs_queue.sync_dispatcher_dlq.id
  policy    = data.aws_iam_policy_document.sync_eventbridge_dlq.json
}
