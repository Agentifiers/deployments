resource "aws_sqs_queue" "automation_failures" {
  name                      = "${local.name_prefix}-automation-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "usage_failures" {
  name                      = "${local.name_prefix}-usage-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "trace_finalization_failures" {
  name                      = "${local.name_prefix}-trace-finalization-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "webhook_event_failures" {
  name                      = "${local.name_prefix}-webhook-event-failures"
  max_message_size          = 1048576
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "artifact_retention_failures" {
  name                      = "${local.name_prefix}-artifact-retention-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

# Only messages the delivery worker could not process (crashes, poison input) reach this queue;
# deliveries that exhaust their attempts are recorded as failed in DynamoDB instead.
resource "aws_sqs_queue" "webhook_delivery_dead_letters" {
  name                      = "${local.name_prefix}-webhook-delivery-dead-letters"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

# One message per webhook delivery. The worker hides a message until its next attempt with
# ChangeMessageVisibility, so a delivery's whole retry schedule (about 8.5 hours) runs on one
# message; the redrive count is a backstop well above the ten attempts plus lease waits.
resource "aws_sqs_queue" "webhook_deliveries" {
  name                       = "${local.name_prefix}-webhook-deliveries"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = local.webhook_delivery_visibility_timeout_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.webhook_delivery_dead_letters.arn
    maxReceiveCount     = local.webhook_delivery_redrive_max_receive_count
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "webhook_delivery_dead_letters" {
  alarm_name          = "${local.name_prefix}-webhook-delivery-dead-letters-visible"
  alarm_description   = "Webhook delivery messages failed processing repeatedly and require replay."
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
    QueueName = aws_sqs_queue.webhook_delivery_dead_letters.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "webhook_delivery_errors" {
  alarm_name          = "${local.name_prefix}-webhook-delivery-errors"
  alarm_description   = "The webhook delivery worker failed whole invocations (timeouts or crashes)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.webhook_deliveries.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "automation_failure_queue" {
  alarm_name          = "${local.name_prefix}-automation-failures-visible"
  alarm_description   = "Automation fire invocations exhausted Lambda retries and require replay."
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
    QueueName = aws_sqs_queue.automation_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "usage_failure_queue" {
  alarm_name          = "${local.name_prefix}-usage-failures-visible"
  alarm_description   = "Usage stream records exhausted Lambda retries and require replay."
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
    QueueName = aws_sqs_queue.usage_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "trace_finalization_failure_queue" {
  alarm_name          = "${local.name_prefix}-trace-finalization-failures-visible"
  alarm_description   = "Trace finalization records exhausted Lambda retries and require replay."
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
    QueueName = aws_sqs_queue.trace_finalization_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "webhook_event_failure_queue" {
  alarm_name          = "${local.name_prefix}-webhook-event-failures-visible"
  alarm_description   = "Webhook event invocations exhausted retries and require replay."
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
    QueueName = aws_sqs_queue.webhook_event_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "artifact_retention_failure_queue" {
  alarm_name          = "${local.name_prefix}-artifact-retention-failures-visible"
  alarm_description   = "Artifact retention records exhausted Lambda retries and require replay."
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
    QueueName = aws_sqs_queue.artifact_retention_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "webhook_event_destination_failures" {
  alarm_name          = "${local.name_prefix}-webhook-event-destination-failures"
  alarm_description   = "Lambda could not retain an exhausted webhook event invocation."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DestinationDeliveryFailures"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.webhook_events.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "usage_destination_failures" {
  alarm_name          = "${local.name_prefix}-usage-materializer-destination-failures"
  alarm_description   = "Lambda could not deliver an exhausted usage stream invocation to SQS."
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
    FunctionName = aws_lambda_function.usage.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "usage_failed_invocations" {
  alarm_name          = "${local.name_prefix}-usage-stream-failed-invocations"
  alarm_description   = "Usage stream records exhausted Lambda event source mapping retries."
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
    EventSourceMappingUUID = aws_lambda_event_source_mapping.usage.uuid
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "usage_failure_deliveries" {
  alarm_name          = "${local.name_prefix}-usage-stream-failure-deliveries"
  alarm_description   = "Usage stream records were delivered to the exhausted-event destination."
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
    EventSourceMappingUUID = aws_lambda_event_source_mapping.usage.uuid
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "usage_iterator_age" {
  alarm_name          = "${local.name_prefix}-usage-stream-iterator-age"
  alarm_description   = "Usage stream processing is more than five minutes behind."
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
    EventSourceMappingUUID = aws_lambda_event_source_mapping.usage.uuid
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
