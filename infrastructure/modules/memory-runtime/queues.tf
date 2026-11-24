resource "aws_sqs_queue" "dlq" {
  for_each = local.workers

  name                        = "${each.key}-dlq${each.key == "memory-index" ? ".fifo" : ""}"
  fifo_queue                  = each.key == "memory-index"
  content_based_deduplication = each.key == "memory-index"
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
  tags                        = local.common_tags
}

resource "aws_sqs_queue" "runtime" {
  for_each = local.workers

  name                        = "${each.key}${each.key == "memory-index" ? ".fifo" : ""}"
  fifo_queue                  = each.key == "memory-index"
  content_based_deduplication = each.key == "memory-index"
  deduplication_scope         = each.key == "memory-index" ? "messageGroup" : null
  fifo_throughput_limit       = each.key == "memory-index" ? "perMessageGroupId" : null
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 345600
  visibility_timeout_seconds  = local.queue_visibility_timeouts[each.key]
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.key == "memory-index" ? local.index_redrive_max_receive_count : 5
  })
  tags = local.common_tags
}

# EventBridge target DLQs must be standard queues even when the destination is FIFO.
resource "aws_sqs_queue" "memory_index_eventbridge_dlq" {
  name                      = "${local.name_prefix}-index-eventbridge-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = local.common_tags
}

resource "aws_cloudwatch_event_rule" "queue" {
  for_each = {
    memory-cleanup          = ["memory.blob-cleanup.requested", "memory.review-content-cleanup.requested"]
    memory-flush            = ["memory.flush.queued"]
    memory-index            = ["memory.index.queued"]
    memory-shadow           = ["memory.shadow.queued"]
    memory-reconcile        = ["memory.reconcile.requested", "memory-space.archived", "memory.reconcile.continuation"]
    memory-search-placement = ["organization.created"]
  }

  name           = each.key
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source        = ["deployments-ai.platform"]
    "detail-type" = each.value
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "queue" {
  for_each       = aws_cloudwatch_event_rule.queue
  event_bus_name = var.event_bus_name
  rule           = each.value.name
  arn            = each.key == "memory-index" ? aws_lambda_function.runtime["memory-index-dispatch"].arn : aws_sqs_queue.runtime[each.key].arn
  target_id      = each.key
  dead_letter_config {
    arn = each.key == "memory-index" ? aws_sqs_queue.memory_index_eventbridge_dlq.arn : aws_sqs_queue.dlq[each.key].arn
  }
}

resource "aws_lambda_permission" "memory_index_eventbridge" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.runtime["memory-index-dispatch"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.queue["memory-index"].arn
  statement_id  = "AllowMemoryIndexEventBridge"
}

resource "aws_lambda_function_event_invoke_config" "memory_index_dispatch" {
  function_name = aws_lambda_function.runtime["memory-index-dispatch"].function_name

  destination_config {
    on_failure {
      destination = aws_sqs_queue.memory_index_eventbridge_dlq.arn
    }
  }
}
