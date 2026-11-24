locals {
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
    },
    var.tags,
  )
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "dispatcher_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_event_bus" "semantic" {
  name = "semantic-events"
  tags = local.common_tags
}

resource "aws_cloudwatch_event_archive" "semantic" {
  name             = "semantic-events"
  description      = "Replay archive for standalone platform semantic events."
  event_source_arn = aws_cloudwatch_event_bus.semantic.arn
  retention_days   = var.archive_retention_days

  event_pattern = jsonencode({
    source = ["deployments-ai.platform"]
  })
}

resource "aws_s3_bucket" "dispatcher_failures" {
  bucket        = "event-failures-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.deletion_protection_enabled
  tags          = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "dispatcher_failures" {
  bucket = aws_s3_bucket.dispatcher_failures.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dispatcher_failures" {
  bucket = aws_s3_bucket.dispatcher_failures.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "dispatcher_failures" {
  bucket = aws_s3_bucket.dispatcher_failures.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "dispatcher_failures" {
  bucket = aws_s3_bucket.dispatcher_failures.id

  rule {
    id     = "expire-dispatcher-failures"
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

resource "aws_cloudwatch_log_group" "dispatcher" {
  name              = "/aws/lambda/event-dispatcher"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "dispatcher" {
  name                 = "event-dispatcher"
  assume_role_policy   = data.aws_iam_policy_document.dispatcher_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "dispatcher" {
  statement {
    sid = "ReadSemanticEventStream"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
    ]
    resources = [var.events_stream_arn]
  }

  statement {
    sid       = "ListSemanticEventStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "PublishSemanticEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.semantic.arn]
  }

  statement {
    sid = "WriteFailureDestination"
    actions = [
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.dispatcher_failures.arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "WriteFailurePayloads"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.dispatcher_failures.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid = "WriteDispatcherLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.dispatcher.arn}:*"]
  }
}

resource "aws_iam_role_policy" "dispatcher" {
  name   = "event-dispatcher"
  role   = aws_iam_role.dispatcher.id
  policy = data.aws_iam_policy_document.dispatcher.json
}

resource "aws_lambda_function" "dispatcher" {
  function_name     = "event-dispatcher"
  description       = "Publishes committed semantic event outbox records from DynamoDB Streams."
  architectures     = ["arm64"]
  handler           = "index.handler"
  memory_size       = 256
  role              = aws_iam_role.dispatcher.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.dispatcher_artifact_bucket
  s3_key            = var.dispatcher_artifact_key
  s3_object_version = var.dispatcher_artifact_version
  timeout           = 30

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_EVENT_BUS_NAME = aws_cloudwatch_event_bus.semantic.name
    }
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.dispatcher,
    aws_iam_role_policy.dispatcher,
  ]
}

resource "aws_lambda_event_source_mapping" "dispatcher" {
  event_source_arn                   = var.events_stream_arn
  function_name                      = aws_lambda_function.dispatcher.arn
  starting_position                  = "TRIM_HORIZON"
  batch_size                         = 100
  maximum_batching_window_in_seconds = 1
  parallelization_factor             = 1
  bisect_batch_on_function_error     = true
  maximum_record_age_in_seconds      = 75600
  maximum_retry_attempts             = 10
  function_response_types            = ["ReportBatchItemFailures"]

  metrics_config {
    metrics = ["EventCount"]
  }

  destination_config {
    on_failure {
      destination_arn = aws_s3_bucket.dispatcher_failures.arn
    }
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT"]
        dynamodb = {
          NewImage = {
            itemType = {
              S = ["semantic-event"]
            }
          }
        }
      })
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "dispatcher_errors" {
  alarm_name          = "event-dispatcher-errors"
  alarm_description   = "Semantic event dispatcher Lambda is returning errors."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.dispatcher.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "dispatcher_partial_batch_failures" {
  alarm_name          = "event-dispatcher-partial-batch-failures"
  alarm_description   = "Semantic event dispatcher returned one or more failed stream records."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedInvokeEventCount"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    EventSourceMappingUUID = aws_lambda_event_source_mapping.dispatcher.uuid
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "dispatcher_iterator_age" {
  alarm_name          = "event-dispatcher-iterator-age"
  alarm_description   = "Semantic event dispatcher is falling behind the DynamoDB Stream."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "IteratorAge"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Maximum"
  threshold           = 60000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.dispatcher.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "dispatcher_destination_failures" {
  alarm_name          = "event-dispatcher-destination-failures"
  alarm_description   = "Lambda could not persist an exhausted semantic event stream record to S3."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DestinationDeliveryFailures"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.dispatcher.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "dispatcher_exhausted_records" {
  alarm_name          = "event-dispatcher-exhausted-records"
  alarm_description   = "Semantic event records exhausted retries and were retained in S3."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "OnFailureDestinationDeliveredEventCount"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    EventSourceMappingUUID = aws_lambda_event_source_mapping.dispatcher.uuid
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
