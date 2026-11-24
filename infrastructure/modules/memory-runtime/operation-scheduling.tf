resource "aws_cloudwatch_event_rule" "memory_operation_reconcile" {
  name                = "${local.name_prefix}-operation-reconcile"
  schedule_expression = "rate(5 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "memory_operation_reconcile" {
  rule      = aws_cloudwatch_event_rule.memory_operation_reconcile.name
  target_id = "memory-operation-reconcile"
  arn       = aws_lambda_function.runtime["memory-operation-reconcile"].arn
  dead_letter_config { arn = aws_sqs_queue.dlq["memory-operation"].arn }
  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }
  depends_on = [aws_sqs_queue_policy.memory_operation_reconcile_dlq]
}

resource "aws_lambda_permission" "memory_operation_reconcile" {
  statement_id  = "AllowMemoryOperationReconcile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.runtime["memory-operation-reconcile"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.memory_operation_reconcile.arn
}

data "aws_iam_policy_document" "memory_operation_reconcile_dlq" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq["memory-operation"].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.memory_operation_reconcile.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "memory_operation_reconcile_dlq" {
  queue_url = aws_sqs_queue.dlq["memory-operation"].url
  policy    = data.aws_iam_policy_document.memory_operation_reconcile_dlq.json
}
