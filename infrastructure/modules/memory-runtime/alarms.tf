resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.alarms_enabled ? aws_lambda_function.runtime : {}

  alarm_name          = "${each.key}-errors"
  alarm_description   = "Memory Lambda ${each.key} is returning errors."
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
    FunctionName = each.value.function_name
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-http-api-5xx"
  alarm_description   = "The memory HTTP API is returning 5xx responses."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xx"
  namespace           = "AWS/ApiGateway"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    ApiId = aws_apigatewayv2_api.memory.id
    Stage = aws_apigatewayv2_stage.memory.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each = var.alarms_enabled ? aws_sqs_queue.dlq : {}

  alarm_name          = "${each.key}-messages"
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

resource "aws_cloudwatch_metric_alarm" "memory_index_eventbridge_dlq" {
  alarm_name          = "${local.name_prefix}-index-eventbridge-dlq-messages"
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
    QueueName = aws_sqs_queue.memory_index_eventbridge_dlq.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
