data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix = "event-analytics"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "event-analytics"
    },
    var.tags,
  )
  query_context_database_name = "event_query_context"
  s3tables_child_catalog_name = "${var.s3tables_catalog_name}/${var.s3_table_bucket_name}"
  s3tables_child_catalog_arn  = "${var.s3tables_catalog_arn}/${var.s3_table_bucket_name}"
  athena_table_ref            = "\"${local.s3tables_child_catalog_name}\".\"${var.s3_table_namespace}\".\"${var.s3_table_name}\""
}

resource "aws_glue_catalog_database" "query_context" {
  name        = local.query_context_database_name
  description = "Root catalog context for fully qualified S3 Tables Athena named queries."
  tags        = local.common_tags
}

resource "aws_s3_bucket" "backup" {
  bucket        = "${local.name_prefix}-backup-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.storage_deletion_protection_enabled || var.destructive_cleanup_enabled
  tags          = local.common_tags
}

resource "aws_s3_bucket" "athena_results" {
  bucket        = "${local.name_prefix}-athena-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.storage_deletion_protection_enabled || var.destructive_cleanup_enabled
  tags          = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "private" {
  for_each = {
    athena = aws_s3_bucket.athena_results.id
    backup = aws_s3_bucket.backup.id
  }

  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  for_each = {
    athena = aws_s3_bucket.athena_results.id
    backup = aws_s3_bucket.backup.id
  }

  bucket = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "private" {
  for_each = {
    athena = aws_s3_bucket.athena_results.id
    backup = aws_s3_bucket.backup.id
  }

  bucket = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "retain-event-analytics-failures"
    status = "Enabled"
    filter {}

    expiration {
      days = var.failure_retention_in_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.failure_retention_in_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "athena_results" {
  bucket = aws_s3_bucket.athena_results.id

  rule {
    id     = "expire-athena-results"
    status = "Enabled"
    filter {}

    expiration {
      days = var.query_result_retention_in_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.query_result_retention_in_days
    }
  }
}

resource "aws_cloudwatch_log_group" "firehose" {
  name              = "/aws/kinesisfirehose/semantic-events"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_stream" "firehose" {
  name           = "iceberg-delivery"
  log_group_name = aws_cloudwatch_log_group.firehose.name
}

data "aws_iam_policy_document" "firehose_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name                 = "${local.name_prefix}-firehose"
  assume_role_policy   = data.aws_iam_policy_document.firehose_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "firehose" {
  statement {
    actions = [
      "glue:GetCatalog",
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetTable",
      "glue:GetTables",
      "glue:GetTableVersion",
      "glue:GetTableVersions",
      "glue:UpdateTable",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "s3tables:GetNamespace",
      "s3tables:GetTableBucket",
      "s3tables:ListNamespaces",
      "s3tables:ListTables",
    ]
    resources = [var.s3_table_bucket_arn]
  }

  statement {
    actions = [
      "s3tables:GetTable",
      "s3tables:GetTableData",
      "s3tables:GetTableMetadataLocation",
      "s3tables:PutTableData",
      "s3tables:UpdateTableMetadataLocation",
    ]
    resources = [var.s3_table_arn]
  }

  statement {
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]
  }

  statement {
    actions   = ["logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.firehose.arn}:log-stream:${aws_cloudwatch_log_stream.firehose.name}"]
  }
}

resource "aws_iam_role_policy" "firehose" {
  name   = "semantic-event-iceberg-delivery"
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose.json
}

resource "aws_kinesis_firehose_delivery_stream" "events" {
  name        = "semantic-events"
  destination = "iceberg"
  tags        = local.common_tags

  iceberg_configuration {
    append_only        = true
    buffering_interval = 60
    buffering_size     = 5
    catalog_arn        = local.s3tables_child_catalog_arn
    role_arn           = aws_iam_role.firehose.arn
    s3_backup_mode     = "FailedDataOnly"

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = aws_cloudwatch_log_stream.firehose.name
    }

    destination_table_configuration {
      database_name = var.s3_table_namespace
      table_name    = var.s3_table_name
    }

    s3_configuration {
      bucket_arn          = aws_s3_bucket.backup.arn
      buffering_interval  = 60
      buffering_size      = 5
      compression_format  = "UNCOMPRESSED"
      error_output_prefix = "errors/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/!{firehose:error-output-type}/"
      prefix              = "backup/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/"
      role_arn            = aws_iam_role.firehose.arn

      cloudwatch_logging_options {
        enabled         = true
        log_group_name  = aws_cloudwatch_log_group.firehose.name
        log_stream_name = aws_cloudwatch_log_stream.firehose.name
      }
    }
  }

  depends_on = [aws_iam_role_policy.firehose]
}

resource "aws_sqs_queue" "projector_dlq" {
  # New event writes cap the serialized EventBridge entry at 256 KiB, leaving
  # headroom for the outer event and service-generated DLQ message attributes.
  name                      = "${local.name_prefix}-projector-dlq"
  max_message_size          = 1048576
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

resource "aws_iam_role" "projector" {
  name                 = "${local.name_prefix}-projector"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "projector" {
  statement {
    actions   = ["firehose:PutRecord"]
    resources = [aws_kinesis_firehose_delivery_stream.events.arn]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.projector_dlq.arn]
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.projector.arn}:*"]
  }
}

resource "aws_iam_role_policy" "projector" {
  name   = "event-analytics-projector"
  role   = aws_iam_role.projector.id
  policy = data.aws_iam_policy_document.projector.json
}

resource "aws_cloudwatch_log_group" "projector" {
  name              = "/aws/lambda/${local.name_prefix}-projector"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_lambda_function" "projector" {
  function_name     = "${local.name_prefix}-projector"
  description       = "Projects validated semantic EventBridge events into the Iceberg analytical log."
  architectures     = ["arm64"]
  handler           = "index.handler"
  memory_size       = 256
  role              = aws_iam_role.projector.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.projector_artifact_bucket
  s3_key            = var.projector_artifact_key
  s3_object_version = var.projector_artifact_version
  timeout           = 30

  dead_letter_config {
    target_arn = aws_sqs_queue.projector_dlq.arn
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_EVENT_ANALYTICS_STREAM_NAME = aws_kinesis_firehose_delivery_stream.events.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.projector, aws_iam_role_policy.projector]
  tags       = local.common_tags
}

resource "aws_cloudwatch_event_rule" "projector" {
  name           = "${local.name_prefix}-projector"
  description    = "Project semantic events into the analytical Iceberg log."
  event_bus_name = var.event_bus_name
  state          = var.projector_enabled ? "ENABLED" : "DISABLED"
  event_pattern = jsonencode({
    source = distinct(concat(["deployments-ai.platform"], var.extra_event_sources))
  })
  tags = local.common_tags
}

data "aws_iam_policy_document" "projector_dlq" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.projector_dlq.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.projector.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "projector_dlq" {
  queue_url = aws_sqs_queue.projector_dlq.url
  policy    = data.aws_iam_policy_document.projector_dlq.json
}

resource "aws_lambda_permission" "eventbridge_projector" {
  statement_id  = "AllowSemanticEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.projector.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.projector.arn
}

resource "aws_cloudwatch_event_target" "projector" {
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.projector.name
  target_id      = "event-analytics-projector"
  arn            = aws_lambda_function.projector.arn

  dead_letter_config {
    arn = aws_sqs_queue.projector_dlq.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_lambda_permission.eventbridge_projector, aws_sqs_queue_policy.projector_dlq]
}
