resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${local.name_prefix}-dlq-visible"
  alarm_description   = "Agent runs are accumulating in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.name_prefix}-queue-age"
  alarm_description   = "Agent run queue latency exceeds five minutes."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300
  dimensions          = { QueueName = aws_sqs_queue.runs.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

# Every running worker task publishes RunSlotUtilization each minute, including
# zero when idle, so missing data means no task is consuming the run queue.
resource "aws_cloudwatch_metric_alarm" "worker_unavailable" {
  alarm_name          = "${local.name_prefix}-worker-unavailable"
  alarm_description   = "No agent worker task has reported run-slot utilization for ten minutes."
  namespace           = local.agent_worker_metric_namespace
  metric_name         = "RunSlotUtilization"
  statistic           = "SampleCount"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  dimensions          = { ServiceName = local.agent_worker_service_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "breaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "api_throttles" {
  alarm_name          = "${local.name_prefix}-api-throttles"
  alarm_description   = "Agent runtime API Lambda invocations are being throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.name_prefix}-api-errors"
  alarm_description   = "Agent runtime API Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "usage_errors" {
  alarm_name          = "${local.name_prefix}-usage-materializer-errors"
  alarm_description   = "Usage materializer Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = aws_lambda_function.usage.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "public_runtime_errors" {
  for_each = var.alarms_enabled ? {
    heartbeat-fire = aws_lambda_function.heartbeat_fire.function_name
    schedule-fire  = aws_lambda_function.schedule_fire.function_name
  } : {}

  alarm_name          = "${local.name_prefix}-${each.key}-errors"
  alarm_description   = "${each.key} Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = each.value }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "public_api_5xx" {
  alarm_name          = "${local.name_prefix}-api-5xx"
  alarm_description   = "The public runtime HTTP API is returning 5xx responses."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions = {
    ApiId = aws_apigatewayv2_api.runtime.id
    Stage = aws_apigatewayv2_stage.runtime.name
  }
  alarm_actions      = [var.alarm_topic_arn]
  ok_actions         = [var.alarm_topic_arn]
  treat_missing_data = "notBreaching"
  tags               = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "run_concurrency_wait_expired" {
  alarm_name          = "${local.name_prefix}-run-concurrency-wait-expired"
  alarm_description   = "Queued agent runs failed after waiting the maximum time for an organization execution slot."
  namespace           = local.tenant_limit_metric_namespace
  metric_name         = "RunConcurrencyWaitExpired"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
