locals {
  alarmed_function_names = {
    api                 = aws_lambda_function.api.function_name
    principal_status    = aws_lambda_function.principal_status.function_name
    public_email_worker = aws_lambda_function.public_email_worker.function_name
    email_dispatcher    = aws_lambda_function.dispatcher.function_name
    email_worker        = aws_lambda_function.worker.function_name
    email_reconciler    = aws_lambda_function.reconciler.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.alarms_enabled ? local.alarmed_function_names : {}

  alarm_name          = "${each.value}-errors"
  alarm_description   = "Identity Lambda ${each.value} is returning errors."
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
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = var.alarms_enabled ? local.alarmed_function_names : {}

  alarm_name          = "${each.value}-throttles"
  alarm_description   = "Identity Lambda ${each.value} is being throttled."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { FunctionName = each.value }
  tags                = local.tags
}
