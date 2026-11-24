locals {
  name_prefix = "brain"
  runtime_names = toset([
    "brain-content-maintenance",
    "brain-erasure-worker",
    "brain-index-dispatch",
    "brain-index-worker",
    "brain-search-erasure",
    "brain-search-placement",
  ])
  runtime_evidence_encryption_names = toset([
    "brain-erasure-worker",
    "brain-index-worker",
    "brain-search-erasure",
  ])
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
  opensearch_endpoint = var.aws_native_enabled ? var.opensearch_endpoint : ""
  # Brain targets must catalog indexes under this prefix (enforced by the Brain
  # provider registry) so a shared domain keeps Brain and Memory roles out of
  # each other's indexes.
  opensearch_index_resources = var.aws_native_enabled ? ["${var.opensearch_domain_arn}/brain-*"] : []
  upload_quota_overrides = {
    for name, limits in {
      hourlyIssuance     = try(var.upload_quotas.hourly_issuance, null)
      outstandingBytes   = try(var.upload_quotas.outstanding_bytes, null)
      outstandingTickets = try(var.upload_quotas.outstanding_tickets, null)
    } : name => { for scope, limit in limits : scope => limit if limit != null }
    if limits == null ? false : anytrue([for limit in values(limits) : limit != null])
  }
  upload_quotas_environment = length(local.upload_quota_overrides) == 0 ? {} : {
    DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS = jsonencode(local.upload_quota_overrides)
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

resource "aws_security_group" "runtime" {
  name_prefix = "${local.name_prefix}-runtime-"
  description = "Brain Lambda egress to DynamoDB, OpenSearch, and provider services"
  vpc_id      = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}

resource "aws_sqs_queue" "index_dlq" {
  name                        = "${local.name_prefix}-index-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
  tags                        = local.common_tags
}

resource "aws_sqs_queue" "dispatcher_dlq" {
  name                      = "${local.name_prefix}-index-dispatch-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "index" {
  name                        = "${local.name_prefix}-index.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 345600
  visibility_timeout_seconds  = 900
  # An index job spends up to two receives per attempt (the failure and a wait for its retry), and
  # transient conflicts add receives that consume no attempt. The job's own attempt budget ends real
  # failures, so only a message that keeps failing for hours reaches the dead-letter queue.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.index_dlq.arn
    maxReceiveCount     = 50
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "runtime" {
  for_each          = local.runtime_names
  name              = "/aws/lambda/${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "runtime" {
  for_each             = local.runtime_names
  name                 = each.key
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "runtime" {
  for_each = aws_iam_role.runtime
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.runtime[each.key].arn}:*"]
  }
  dynamic "statement" {
    for_each = each.key == "brain-index-dispatch" ? [1] : []
    content {
      sid       = "DispatchBrainIndex"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.index.arn, aws_sqs_queue.dispatcher_dlq.arn]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-search-placement" ? [1] : []
    content {
      sid       = "RecordFailedBrainSearchPlacement"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.search_placement_dlq.arn]
    }
  }
  dynamic "statement" {
    for_each = contains(["brain-content-maintenance", "brain-erasure-worker", "brain-index-dispatch", "brain-index-worker", "brain-search-erasure", "brain-search-placement"], each.key) ? [1] : []
    content {
      sid = "BrainTables"
      actions = [
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
  }
  dynamic "statement" {
    for_each = each.key == "brain-content-maintenance" ? [1] : []
    content {
      sid       = "DeleteExpiredBrainContentRecords"
      actions   = ["dynamodb:DeleteItem"]
      resources = [var.dynamodb_table_arns["control"], var.dynamodb_table_arns["execution"]]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-erasure-worker" ? [1] : []
    content {
      sid = "InventoryAndDeleteBrainRecords"
      actions = [
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:DeleteItem",
      ]
      resources = values(var.dynamodb_table_arns)
    }
  }
  dynamic "statement" {
    for_each = contains(["brain-content-maintenance", "brain-erasure-worker"], each.key) ? [1] : []
    content {
      sid     = "MaintainBrainContent"
      actions = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
      resources = flatten([
        for bucket_arn in concat([var.content_bucket_arn], var.legacy_content_bucket_arns) : [
          bucket_arn,
          "${bucket_arn}/memory/*",
          "${bucket_arn}/organizations/*",
        ]
      ])
    }
  }
  # A run that used Brain evidence publishes its answer as a run artifact tagged with the Brain,
  # so Brain erasure must delete it from the run artifact prefix as well.
  dynamic "statement" {
    for_each = each.key == "brain-erasure-worker" ? [1] : []
    content {
      sid     = "EraseBrainRunPublications"
      actions = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
      resources = [
        for bucket_arn in concat([var.content_bucket_arn], var.legacy_content_bucket_arns) : "${bucket_arn}/artifacts/organizations/*"
      ]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-index-worker" ? [1] : []
    content {
      sid     = "BrainEvidence"
      actions = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = [
        for bucket_arn in concat([var.content_bucket_arn], var.legacy_content_bucket_arns) : "${bucket_arn}/organizations/*/brains/*"
      ]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-index-worker" ? [1] : []
    content {
      sid       = "WriteBrainDocumentText"
      actions   = ["s3:PutObject"]
      resources = ["${var.content_bucket_arn}/organizations/*/brains/*/document-versions/*/text/document-text-v1.txt"]
      condition {
        test     = "StringEquals"
        variable = "s3:if-none-match"
        values   = ["*"]
      }
    }
  }
  dynamic "statement" {
    for_each = var.aws_native_enabled && contains(["brain-erasure-worker", "brain-index-worker", "brain-search-erasure", "brain-search-placement"], each.key) ? [1] : []
    content {
      sid       = "BrainOpenSearch"
      actions   = ["es:ESHttpDelete", "es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut"]
      resources = local.opensearch_index_resources
    }
  }
  dynamic "statement" {
    for_each = contains(local.runtime_evidence_encryption_names, each.key) ? [1] : []
    content {
      sid = "BrainEvidenceEncryption"
      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:GenerateDataKey",
      ]
      resources = [var.data_kms_key_arn]
      # Evidence objects are SSE-KMS under the shared data key; only S3 may use it on their behalf.
      condition {
        test     = "StringLike"
        variable = "kms:ViaService"
        values   = ["s3.*.amazonaws.com"]
      }
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-index-worker" ? [1] : []
    content {
      sid       = "InvokeModelTokenIssuer"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.model_gateway_token_issuer.arn]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-index-worker" ? [1] : []
    content {
      sid       = "InvokeDocumentExtraction"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.document_extraction_function.arn]
    }
  }
  dynamic "statement" {
    for_each = contains(["brain-erasure-worker", "brain-index-worker", "brain-search-erasure", "brain-search-placement"], each.key) ? [1] : []
    content {
      sid = "VpcNetworking"
      actions = [
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
      ]
      resources = ["*"]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-erasure-worker" ? [1] : []
    content {
      sid       = "PurgeBrainDerivedMemory"
      actions   = ["lambda:InvokeFunction"]
      resources = [var.memory_erasure_function_arn]
    }
  }
  dynamic "statement" {
    for_each = each.key == "brain-index-worker" ? [1] : []
    content {
      sid = "ConsumeBrainIndex"
      actions = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
      ]
      resources = [aws_sqs_queue.index.arn]
    }
  }
}

resource "aws_iam_role_policy" "runtime" {
  for_each = data.aws_iam_policy_document.runtime
  name     = "brain-runtime"
  role     = aws_iam_role.runtime[each.key].id
  policy   = each.value.json
}

resource "aws_lambda_function" "dispatcher" {
  function_name     = "${local.name_prefix}-index-dispatch"
  architectures     = ["arm64"]
  handler           = "brain-index-dispatcher-main.handler"
  memory_size       = 256
  role              = aws_iam_role.runtime["brain-index-dispatch"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 30
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = { DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL = aws_sqs_queue.index.url }
  }
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_lambda_function" "content_maintenance" {
  function_name     = "${local.name_prefix}-content-maintenance"
  architectures     = ["arm64"]
  handler           = "brain-content-maintenance-main.handler"
  memory_size       = 1024
  role              = aws_iam_role.runtime["brain-content-maintenance"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 840
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = {
      DEPLOYMENTS_AI_ARTIFACT_BUCKET              = var.content_bucket_name
      DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = jsonencode(var.legacy_content_bucket_names)
      DEPLOYMENTS_AI_CONTROL_TABLE                = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE                 = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE              = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE                  = var.dynamodb_table_names["usage"]
    }
  }
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_cloudwatch_event_rule" "content_maintenance" {
  name                = "${local.name_prefix}-content-maintenance"
  schedule_expression = "rate(5 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "content_maintenance" {
  arn  = aws_lambda_function.content_maintenance.arn
  rule = aws_cloudwatch_event_rule.content_maintenance.name
}

resource "aws_lambda_permission" "content_maintenance" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.content_maintenance.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.content_maintenance.arn
  statement_id  = "AllowBrainContentMaintenance"
}

resource "aws_lambda_function" "brain_erasure_worker" {
  function_name     = "${local.name_prefix}-erasure-worker"
  architectures     = ["arm64"]
  handler           = "brain-erasure-main.handler"
  memory_size       = 2048
  role              = aws_iam_role.runtime["brain-erasure-worker"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 840
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = {
      DEPLOYMENTS_AI_ARTIFACT_BUCKET              = var.content_bucket_name
      DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = jsonencode(var.legacy_content_bucket_names)
      DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN         = var.data_kms_key_arn
      DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT    = local.opensearch_endpoint
      DEPLOYMENTS_AI_CONTROL_TABLE                = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE                 = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE              = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME = var.memory_erasure_function_name
      DEPLOYMENTS_AI_USAGE_TABLE                  = var.dynamodb_table_names["usage"]
    }
  }
  vpc_config {
    security_group_ids = [aws_security_group.runtime.id]
    subnet_ids         = var.private_subnet_ids
  }
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

# Ticks run more often than any job delay, so a tick that fires a moment before a job is due
# delays it by at most a minute instead of a whole retry interval.
resource "aws_cloudwatch_event_rule" "brain_erasure" {
  name                = "${local.name_prefix}-erasure"
  schedule_expression = "rate(1 minute)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "brain_erasure" {
  arn  = aws_lambda_function.brain_erasure_worker.arn
  rule = aws_cloudwatch_event_rule.brain_erasure.name
}

resource "aws_lambda_permission" "brain_erasure" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.brain_erasure_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.brain_erasure.arn
  statement_id  = "AllowBrainErasure"
}

resource "aws_lambda_function" "worker" {
  function_name     = "${local.name_prefix}-index-worker"
  architectures     = ["arm64"]
  handler           = "brain-index-worker-main.handler"
  memory_size       = 2048
  role              = aws_iam_role.runtime["brain-index-worker"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 840
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = {
      DEPLOYMENTS_AI_ARTIFACT_BUCKET                   = var.content_bucket_name
      DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN              = var.data_kms_key_arn
      DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON      = jsonencode(var.legacy_content_bucket_names)
      DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS        = join(",", var.model_gateway_fallback_ids)
      DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME = var.document_extraction_function.function_name
      DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL            = var.model_gateway_base_url
      DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER        = var.model_gateway_token_issuer.function_name
      DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT         = local.opensearch_endpoint
      DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL             = aws_sqs_queue.index.url
      DEPLOYMENTS_AI_CONTROL_TABLE                     = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE                      = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE                   = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE                       = var.dynamodb_table_names["usage"]
    }
  }
  vpc_config {
    security_group_ids = [aws_security_group.runtime.id]
    subnet_ids         = var.private_subnet_ids
  }
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_lambda_function" "erasure" {
  function_name     = "${local.name_prefix}-search-erasure"
  architectures     = ["arm64"]
  handler           = "brain-search-erasure-main.handler"
  memory_size       = 1024
  role              = aws_iam_role.runtime["brain-search-erasure"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 840
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = {
      DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT = local.opensearch_endpoint
      DEPLOYMENTS_AI_CONTROL_TABLE             = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE              = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE           = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE               = var.dynamodb_table_names["usage"]
    }
  }
  vpc_config {
    security_group_ids = [aws_security_group.runtime.id]
    subnet_ids         = var.private_subnet_ids
  }
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_cloudwatch_event_rule" "index" {
  name           = "${local.name_prefix}-index"
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source = ["deployments-ai.platform"]
    "detail-type" = [
      "brain-document.archive-captured",
      "brain-document.content-captured",
      "brain-document.restore-captured",
      "brain-document.tombstone-captured",
    ]
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "index" {
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.index.name
  arn            = aws_lambda_function.dispatcher.arn
  target_id      = "brain-index-dispatch"
  dead_letter_config { arn = aws_sqs_queue.dispatcher_dlq.arn }
}

data "aws_iam_policy_document" "eventbridge_dlq" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dispatcher_dlq.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.index.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "eventbridge_dlq" {
  queue_url = aws_sqs_queue.dispatcher_dlq.url
  policy    = data.aws_iam_policy_document.eventbridge_dlq.json
}

resource "aws_lambda_permission" "eventbridge" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.index.arn
  statement_id  = "AllowBrainIndexEventBridge"
}

resource "aws_cloudwatch_event_rule" "index_sweep" {
  name                = "${local.name_prefix}-index-sweep"
  schedule_expression = "rate(5 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "index_sweep" {
  arn   = aws_lambda_function.dispatcher.arn
  input = jsonencode({ kind = "brain-index-dispatch-sweep" })
  rule  = aws_cloudwatch_event_rule.index_sweep.name
}

resource "aws_lambda_permission" "index_sweep" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.index_sweep.arn
  statement_id  = "AllowBrainIndexSweep"
}

resource "aws_lambda_function_event_invoke_config" "dispatcher" {
  function_name = aws_lambda_function.dispatcher.function_name
  destination_config {
    on_failure { destination = aws_sqs_queue.dispatcher_dlq.arn }
  }
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn        = aws_sqs_queue.index.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = var.index_worker_maximum_concurrency }
}

resource "aws_iam_policy" "query" {
  name_prefix = "${local.name_prefix}-query-"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = var.aws_native_enabled ? [
      {
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost"]
        Resource = local.opensearch_index_resources
      },
    ] : []
  })
  tags = local.common_tags

  lifecycle {
    precondition {
      condition     = var.aws_native_enabled
      error_message = "Brain query requires the AWS-native search provider (aws_native_enabled)."
    }
  }
}
