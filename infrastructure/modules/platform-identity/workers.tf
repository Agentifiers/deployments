resource "aws_lambda_event_source_mapping" "email_stream" {
  depends_on = [aws_iam_role_policy.dispatcher]

  event_source_arn               = var.identity_email_stream_arn
  function_name                  = aws_lambda_function.dispatcher.arn
  starting_position              = "TRIM_HORIZON"
  batch_size                     = 25
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = 10
  function_response_types        = ["ReportBatchItemFailures"]
  filter_criteria {
    filter {
      pattern = jsonencode({ dynamodb = { NewImage = {
        itemType = { S = ["identity-email-delivery"] }
        data     = { M = { status = { S = ["pending"] } } }
      } } })
    }
  }
}

resource "aws_lambda_event_source_mapping" "email_queue" {
  depends_on = [aws_iam_role_policy.worker]

  event_source_arn        = aws_sqs_queue.email.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "public_email_request_queue" {
  depends_on = [aws_iam_role_policy.public_email_worker]

  event_source_arn        = aws_sqs_queue.public_email_request.arn
  function_name           = aws_lambda_function.public_email_worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_event_rule" "reconcile" {
  name                = "${local.name}-email-reconcile"
  schedule_expression = "rate(5 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "reconcile" {
  rule = aws_cloudwatch_event_rule.reconcile.name
  arn  = aws_lambda_function.reconciler.arn
}

resource "aws_lambda_permission" "reconcile" {
  statement_id  = "AllowIdentityEmailReconcileSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconcile.arn
}

resource "aws_cloudwatch_metric_alarm" "email_dlq" {
  alarm_name          = "${local.name}-email-dlq-visible"
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
  dimensions          = { QueueName = aws_sqs_queue.email_dlq.name }
  tags                = local.tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "public_email_request_dlq" {
  alarm_name          = "${local.name}-public-email-request-dlq-visible"
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
  dimensions          = { QueueName = aws_sqs_queue.public_email_request_dlq.name }
  tags                = local.tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.name}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5XXError"
  namespace           = "AWS/ApiGateway"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    ApiName = aws_api_gateway_rest_api.identity.name
    Stage   = aws_api_gateway_stage.identity.stage_name
  }
  tags = local.tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
