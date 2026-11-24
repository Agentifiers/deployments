resource "aws_sqs_queue" "dlq" {
  for_each = local.queue_names

  content_based_deduplication = each.key == "maintenance"
  fifo_queue                  = each.key == "maintenance"
  name                        = "${local.name_prefix}-${each.key}-dlq${each.key == "maintenance" ? ".fifo" : ""}"
  message_retention_seconds   = 1209600
  sqs_managed_sse_enabled     = true
  tags                        = local.tags
}

resource "aws_sqs_queue" "worker" {
  for_each = local.queue_names

  content_based_deduplication = each.key == "maintenance"
  fifo_queue                  = each.key == "maintenance"
  name                        = "${local.name_prefix}-${each.key}${each.key == "maintenance" ? ".fifo" : ""}"
  message_retention_seconds   = 1209600
  receive_wait_time_seconds   = 20
  visibility_timeout_seconds  = local.queue_visibility_timeouts[each.key]
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })
  sqs_managed_sse_enabled = true
  tags                    = local.tags
}

resource "aws_sqs_queue" "stream_dispatcher_dlq" {
  name                      = "${local.name_prefix}-stream-dispatcher-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.tags
}

# SES publishes receipt and sending events to these topics. The AWS managed SNS key does not
# admit service publishers, so the shared data key (whose policy lets SES encrypt for these
# topics only) protects them.
resource "aws_sns_topic" "inbound" {
  name              = "${local.name_prefix}-inbound"
  kms_master_key_id = var.data_kms_key_arn
  tags              = local.tags
}

resource "aws_sns_topic" "events" {
  name              = "${local.name_prefix}-events"
  kms_master_key_id = var.data_kms_key_arn
  tags              = local.tags
}

data "aws_iam_policy_document" "sns_topic" {
  for_each = {
    events  = aws_sns_topic.events.arn
    inbound = aws_sns_topic.inbound.arn
  }

  statement {
    sid       = "AllowSesPublish"
    actions   = ["sns:Publish"]
    resources = [each.value]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "email" {
  for_each = data.aws_iam_policy_document.sns_topic

  arn    = each.key == "events" ? aws_sns_topic.events.arn : aws_sns_topic.inbound.arn
  policy = each.value.json
}

resource "aws_sns_topic_subscription" "inbound" {
  topic_arn            = aws_sns_topic.inbound.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.worker["inbound"].arn
  raw_message_delivery = true
}

resource "aws_sns_topic_subscription" "events" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.worker["events"].arn
  raw_message_delivery = true
}

data "aws_iam_policy_document" "sns_to_sqs" {
  for_each = {
    events = {
      queue_arn = aws_sqs_queue.worker["events"].arn
      topic_arn = aws_sns_topic.events.arn
    }
    inbound = {
      queue_arn = aws_sqs_queue.worker["inbound"].arn
      topic_arn = aws_sns_topic.inbound.arn
    }
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [each.value.queue_arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = each.key == "events" ? "ArnLike" : "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        each.key == "events" ?
        "arn:${data.aws_partition.current.partition}:sns:*:${var.account_id}:${aws_sns_topic.events.name}" :
        each.value.topic_arn
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "sns" {
  for_each = data.aws_iam_policy_document.sns_to_sqs

  queue_url = aws_sqs_queue.worker[each.key].url
  policy    = each.value.json
}
