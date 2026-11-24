# Every worker tick reports the failed (retry-exhausted) Brain erasures, so this alarm stays in
# ALARM until an operator resumes or resolves each one.
resource "aws_cloudwatch_metric_alarm" "erasure_failed_jobs" {
  alarm_name          = "${local.name_prefix}-erasure-failed-jobs"
  alarm_description   = "A Brain erasure exhausted its automatic retries and needs an operator."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedErasureJobs"
  namespace           = "DeploymentsAI/Brain"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "erasure_worker_errors" {
  alarm_name          = "${local.name_prefix}-erasure-worker-errors"
  alarm_description   = "The Brain erasure worker failed a whole tick (crash or timeout)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { FunctionName = aws_lambda_function.brain_erasure_worker.function_name }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.alarms_enabled ? {
    index-dispatch      = aws_lambda_function.dispatcher.function_name
    index-worker        = aws_lambda_function.worker.function_name
    sync-dispatch       = aws_lambda_function.sync_dispatcher.function_name
    sync-worker         = aws_lambda_function.sync_worker.function_name
    content-maintenance = aws_lambda_function.content_maintenance.function_name
    search-erasure      = aws_lambda_function.erasure.function_name
    search-placement    = aws_lambda_function.search_placement.function_name
  } : {}

  alarm_name          = "${local.name_prefix}-${each.key}-errors"
  alarm_description   = "Brain ${each.key} Lambda is returning errors."
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
  dimensions          = { FunctionName = each.value }
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "dlq_visible" {
  for_each = var.alarms_enabled ? {
    index            = aws_sqs_queue.index_dlq.name
    index-dispatch   = aws_sqs_queue.dispatcher_dlq.name
    search-placement = aws_sqs_queue.search_placement_dlq.name
    sync             = aws_sqs_queue.sync_dlq.name
    sync-dispatch    = aws_sqs_queue.sync_dispatcher_dlq.name
  } : {}

  alarm_name          = "${local.name_prefix}-${each.key}-dlq-visible"
  alarm_description   = "Brain ${each.key} dead-letter queue contains messages."
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
  dimensions          = { QueueName = each.value }
  tags                = local.common_tags
}
