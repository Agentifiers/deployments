resource "aws_cloudwatch_metric_alarm" "notifier_errors" {
  alarm_name          = "ops-alerts-notifier-errors"
  alarm_description   = "Ops alerts notifier Lambda failed to deliver an alarm notification to Slack."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]
  ok_actions          = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.notifier.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = local.connected
  }
}

resource "aws_cloudwatch_metric_alarm" "notifier_failures" {
  alarm_name          = "ops-alerts-notifier-failures-visible"
  alarm_description   = "Ops alerts notifications exhausted Lambda retries and were retained in the failure queue."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]
  ok_actions          = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    QueueName = aws_sqs_queue.notifier_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = local.connected
  }
}
