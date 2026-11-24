data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix = "agent-observability"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "agent-observability"
    },
    var.tags,
  )
  normalizers = {
    execution = {
      handler    = "observability-normalizer-main.executionHandler"
      stream_arn = var.execution_table_stream_arn
    }
    usage = {
      handler    = "observability-normalizer-main.usageHandler"
      stream_arn = var.usage_table_stream_arn
    }
  }
}

resource "aws_kinesis_stream" "facts" {
  name             = "${local.name_prefix}-facts"
  retention_period = var.fact_stream_retention_hours
  shard_count      = 1

  encryption_type = "KMS"
  kms_key_id      = "alias/aws/kinesis"

  shard_level_metrics = [
    "IncomingBytes",
    "IncomingRecords",
    "IteratorAgeMilliseconds",
    "OutgoingBytes",
    "OutgoingRecords",
    "ReadProvisionedThroughputExceeded",
    "WriteProvisionedThroughputExceeded",
  ]

  stream_mode_details {
    stream_mode = "PROVISIONED"
  }

  tags = local.common_tags
}

resource "aws_dynamodb_table" "projector_checkpoints" {
  name                        = "${local.name_prefix}-projector-checkpoints"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "streamArn"
  range_key                   = "shardId"
  deletion_protection_enabled = var.deletion_protection_enabled

  attribute {
    name = "streamArn"
    type = "S"
  }
  attribute {
    name = "shardId"
    type = "S"
  }
  point_in_time_recovery {
    enabled = var.point_in_time_recovery_enabled
  }
  # enabled = false selects the AWS owned key; omitting the block would keep a prior key.
  server_side_encryption {
    enabled = false
  }
  tags = local.common_tags
}

resource "aws_s3_bucket" "runtime" {
  for_each = toset(["athena", "backup", "quarantine"])

  bucket        = "agent-observability-${each.key}-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.deletion_protection_enabled || var.destructive_cleanup_enabled
  tags          = merge(local.common_tags, { Purpose = each.key })
}

resource "aws_s3_bucket_public_access_block" "runtime" {
  for_each = aws_s3_bucket.runtime

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "runtime" {
  for_each = aws_s3_bucket.runtime

  bucket = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "runtime" {
  for_each = aws_s3_bucket.runtime

  bucket = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "runtime" {
  for_each = aws_s3_bucket.runtime

  bucket = each.value.id
  rule {
    id     = "bounded-retention"
    status = "Enabled"
    filter {}

    expiration {
      days = each.key == "quarantine" ? 365 : var.history_retention_in_days
    }

    noncurrent_version_expiration {
      noncurrent_days = each.key == "quarantine" ? 365 : var.history_retention_in_days
    }
  }
}

data "aws_iam_policy_document" "secure_transport" {
  for_each = aws_s3_bucket.runtime

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      each.value.arn,
      "${each.value.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "secure_transport" {
  for_each = aws_s3_bucket.runtime

  bucket = each.value.id
  policy = data.aws_iam_policy_document.secure_transport[each.key].json
}

resource "aws_sqs_queue" "failures" {
  for_each = toset(["normalizer-execution", "normalizer-usage", "projector"])

  name                      = "${local.name_prefix}-${each.key}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
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

resource "aws_iam_role" "runtime" {
  name                 = local.name_prefix
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "runtime" {
  statement {
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.projector.arn}:*",
      "${aws_cloudwatch_log_group.normalizer["execution"].arn}:*",
      "${aws_cloudwatch_log_group.normalizer["usage"].arn}:*",
    ]
  }

  statement {
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
    resources = [var.execution_table_stream_arn, var.usage_table_stream_arn]
  }

  statement {
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table_arn]
  }

  statement {
    actions   = ["kinesis:PutRecords"]
    resources = [aws_kinesis_stream.facts.arn]
  }

  statement {
    actions = [
      "kinesis:DescribeStream",
      "kinesis:DescribeStreamSummary",
      "kinesis:GetRecords",
      "kinesis:GetShardIterator",
      "kinesis:ListShards",
      "kinesis:SubscribeToShard",
    ]
    resources = [aws_kinesis_stream.facts.arn]
  }

  statement {
    actions   = ["kinesis:ListStreams"]
    resources = ["*"]
  }

  statement {
    actions   = ["firehose:PutRecordBatch"]
    resources = [for stream in aws_kinesis_firehose_delivery_stream.history : stream.arn]
  }

  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.projector_checkpoints.arn]
  }

  statement {
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObject"]
    resources = ["${aws_s3_bucket.runtime["quarantine"].arn}/*"]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [for queue in aws_sqs_queue.failures : queue.arn]
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "agent-observability-runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_cloudwatch_log_group" "normalizer" {
  for_each = local.normalizers

  name              = "/aws/lambda/${local.name_prefix}-normalizer-${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "projector" {
  name              = "/aws/lambda/${local.name_prefix}-projector"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_lambda_function" "normalizer" {
  for_each = local.normalizers

  function_name = "${local.name_prefix}-normalizer-${each.key}"
  description   = "Normalizes ${each.key} DynamoDB stream records into versioned observability facts."
  architectures = ["arm64"]
  handler       = each.value.handler
  memory_size   = 512
  role          = aws_iam_role.runtime.arn
  runtime       = "nodejs26.x"
  timeout       = 60

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_CONTROL_TABLE                   = var.control_table_name
      DEPLOYMENTS_AI_OBSERVABILITY_KINESIS_STREAM    = aws_kinesis_stream.facts.name
      DEPLOYMENTS_AI_OBSERVABILITY_QUARANTINE_BUCKET = aws_s3_bucket.runtime["quarantine"].id
    }
  }

  depends_on = [aws_cloudwatch_log_group.normalizer, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_lambda_function" "projector" {
  function_name = "${local.name_prefix}-projector"
  description   = "Projects versioned observability facts into append-only Iceberg history."
  architectures = ["arm64"]
  handler       = "observability-projector-main.handler"
  memory_size   = 512
  role          = aws_iam_role.runtime.arn
  runtime       = "nodejs26.x"
  timeout       = 60

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_OBSERVABILITY_FIREHOSE_STREAMS = jsonencode({
        for name, stream in aws_kinesis_firehose_delivery_stream.history : name => stream.name
      })
      DEPLOYMENTS_AI_OBSERVABILITY_PROJECTOR_CHECKPOINT_TABLE = aws_dynamodb_table.projector_checkpoints.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.projector, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_lambda_event_source_mapping" "normalizer" {
  for_each = local.normalizers

  event_source_arn  = each.value.stream_arn
  function_name     = aws_lambda_function.normalizer[each.key].arn
  starting_position = "TRIM_HORIZON"

  batch_size                     = 100
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]
  maximum_record_age_in_seconds  = 86400
  maximum_retry_attempts         = 10

  metrics_config {
    metrics = ["EventCount"]
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.failures["normalizer-${each.key}"].arn
    }
  }
}

resource "aws_lambda_event_source_mapping" "projector" {
  event_source_arn  = aws_kinesis_stream.facts.arn
  function_name     = aws_lambda_function.projector.arn
  starting_position = "TRIM_HORIZON"

  batch_size                         = 100
  bisect_batch_on_function_error     = true
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 5
  maximum_record_age_in_seconds      = 259200
  maximum_retry_attempts             = 10

  metrics_config {
    metrics = ["EventCount"]
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.failures["projector"].arn
    }
  }
}
