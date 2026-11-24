locals {
  lambda_functions = merge(
    { for name, function in aws_lambda_function.normalizer : "normalizer-${name}" => function.function_name },
    { projector = aws_lambda_function.projector.function_name },
  )
}

resource "aws_cloudwatch_metric_alarm" "failure_queue" {
  for_each = var.alarms_enabled ? aws_sqs_queue.failures : {}

  alarm_name          = "${local.name_prefix}-${each.key}-failures-visible"
  alarm_description   = "Observability ${each.key} records exhausted retries and require replay."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    QueueName = each.value.name
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.alarms_enabled ? merge(local.lambda_functions, { erasure = aws_lambda_function.erasure.function_name }) : {}

  alarm_name          = "${local.name_prefix}-${each.key}-errors"
  alarm_description   = "Observability ${each.key} Lambda is returning errors."
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
    FunctionName = each.value
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "partial_batch_failures" {
  for_each = var.alarms_enabled ? local.lambda_functions : {}

  alarm_name          = "${local.name_prefix}-${each.key}-partial-batch-failures"
  alarm_description   = "Observability ${each.key} returned records for partial-batch retry."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedRecordCount"
  namespace           = "DeploymentsAI/AgentObservability"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    Pipeline = each.key
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "iterator_age" {
  for_each = var.alarms_enabled ? local.lambda_functions : {}

  alarm_name          = "${local.name_prefix}-${each.key}-iterator-age"
  alarm_description   = "Observability ${each.key} processing is more than five minutes behind."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "IteratorAge"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Maximum"
  threshold           = 300000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    FunctionName = each.value
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "kinesis_write_throttle" {
  alarm_name          = "${local.name_prefix}-kinesis-write-throttle"
  alarm_description   = "The provisioned observability fact stream is throttling writes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "WriteProvisionedThroughputExceeded"
  namespace           = "AWS/Kinesis"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    StreamName = aws_kinesis_stream.facts.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "kinesis_read_throttle" {
  alarm_name          = "${local.name_prefix}-kinesis-read-throttle"
  alarm_description   = "The provisioned observability fact stream is throttling reads."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReadProvisionedThroughputExceeded"
  namespace           = "AWS/Kinesis"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    StreamName = aws_kinesis_stream.facts.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "firehose_freshness" {
  for_each = var.alarms_enabled ? aws_kinesis_firehose_delivery_stream.history : {}

  alarm_name          = "${local.name_prefix}-${each.key}-firehose-freshness"
  alarm_description   = "Firehose has not committed ${each.key} observability rows to Iceberg within fifteen minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "DeliveryToIceberg.DataFreshness"
  namespace           = "AWS/Firehose"
  period              = 300
  statistic           = "Maximum"
  threshold           = 900
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    DeliveryStreamName = each.value.name
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "firehose_failed_rows" {
  for_each = var.alarms_enabled ? aws_kinesis_firehose_delivery_stream.history : {}

  alarm_name          = "${local.name_prefix}-${each.key}-firehose-failed-rows"
  alarm_description   = "Firehose rejected one or more ${each.key} observability rows."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DeliveryToIceberg.FailedRowCount"
  namespace           = "AWS/Firehose"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    DeliveryStreamName = each.value.name
  }
  tags = local.common_tags
}
