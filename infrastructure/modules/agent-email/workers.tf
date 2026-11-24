data "aws_iam_policy_document" "worker" {
  for_each = toset(["events", "inbound", "maintenance", "send", "stream-dispatcher"])

  source_policy_documents = each.key == "inbound" ? data.aws_iam_policy_document.inbound_attachment_capture[*].json : []

  dynamic "statement" {
    for_each = each.key == "stream-dispatcher" ? [] : [1]
    content {
      actions = [
        "dynamodb:ConditionCheckItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
      ]
      resources = concat(
        values(var.dynamodb_table_arns),
        [for arn in values(var.dynamodb_table_arns) : "${arn}/index/*"],
      )
    }
  }


  dynamic "statement" {
    for_each = contains(["inbound", "maintenance", "send"], each.key) && length(var.legacy_bucket_arns) > 0 ? [1] : []
    content {
      sid = "ReadDeleteLegacyAgentEmailObjects"
      actions = [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucketVersions",
      ]
      resources = flatten([
        for bucket_arn in var.legacy_bucket_arns : [bucket_arn, "${bucket_arn}/*"]
      ])
    }
  }

  dynamic "statement" {
    for_each = contains(keys(local.worker_queue_permissions), each.key) ? [1] : []
    content {
      actions = each.key == "maintenance" ? [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        ] : [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        "sqs:SendMessage",
      ]
      resources = concat(
        [for queue in local.worker_queue_permissions[each.key] : aws_sqs_queue.worker[queue].arn],
        each.key == "inbound" && local.inbound_worker_configured ? [var.agent_run_queue_arn] : [],
      )
    }
  }

  dynamic "statement" {
    for_each = each.key == "maintenance" ? [1] : []
    content {
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.worker["send"].arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "stream-dispatcher" && var.events_stream_arn != "" ? [1] : []
    content {
      actions = [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
      ]
      resources = [var.events_stream_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "stream-dispatcher" && var.events_stream_arn != "" ? [1] : []
    content {
      actions   = ["dynamodb:ListStreams"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "stream-dispatcher" ? [1] : []
    content {
      actions = ["sqs:SendMessage"]
      resources = [
        aws_sqs_queue.stream_dispatcher_dlq.arn,
        aws_sqs_queue.worker["send"].arn,
      ]
    }
  }

  dynamic "statement" {
    for_each = contains(["inbound", "maintenance", "send"], each.key) ? [1] : []
    content {
      actions = [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
      ]
      resources = [aws_s3_bucket.email.arn, "${aws_s3_bucket.email.arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "inbound" ? [1] : []
    content {
      sid       = "InspectInboundObjectExistence"
      actions   = ["s3:ListBucketVersions"]
      resources = [aws_s3_bucket.email.arn]

      condition {
        test     = "StringLike"
        variable = "s3:prefix"
        values   = ["${local.raw_prefix}*"]
      }
    }
  }

  dynamic "statement" {
    for_each = contains(["maintenance", "send"], each.key) ? [1] : []
    content {
      actions   = ["s3:ListBucketVersions"]
      resources = [aws_s3_bucket.email.arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "send" ? [1] : []
    content {
      actions = [
        "ses:SendEmail",
        "ses:SendRawEmail",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "events" ? [1] : []
    content {
      actions   = ["ses:PutSuppressedDestination"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "maintenance" && !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") ? [1] : []
    content {
      actions = [
        "ses:CreateConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:CreateDedicatedIpPool",
        "ses:CreateEmailIdentity",
        "ses:CreateMultiRegionEndpoint",
        "ses:CreateTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteConfigurationSet",
        "ses:DeleteDedicatedIpPool",
        "ses:DeleteEmailIdentity",
        "ses:DeleteMultiRegionEndpoint",
        "ses:DeleteSuppressedDestination",
        "ses:DeleteTenant",
        "ses:DeleteTenantResourceAssociation",
        "ses:GetAccount",
        "ses:GetConfigurationSet",
        "ses:GetDedicatedIpPool",
        "ses:GetEmailIdentity",
        "ses:GetMultiRegionEndpoint",
        "ses:GetReputationEntity",
        "ses:GetTenant",
        "ses:ListTagsForResource",
        "ses:ListTenantResources",
        "ses:PutConfigurationSetDeliveryOptions",
        "ses:PutConfigurationSetSendingOptions",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:PutSuppressedDestination",
        "ses:PutTenantSuppressionAttributes",
        "ses:ReplicateEmailIdentityDKIMSigningKey",
        "ses:TagResource",
        "ses:UpdateConfigurationSetEventDestination",
        "ses:UpdateReputationEntityCustomerManagedStatus",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "maintenance" && !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") ? [1] : []
    content {
      actions = [
        "sns:CreateTopic",
        "sns:ListSubscriptionsByTopic",
        "sns:ListTagsForResource",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:TagResource",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "maintenance" && !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") ? [1] : []
    content {
      actions   = ["iam:CreateServiceLinkedRole"]
      resources = ["arn:${data.aws_partition.current.partition}:iam::*:role/aws-service-role/ses.amazonaws.com/*"]

      condition {
        test     = "StringEquals"
        variable = "iam:AWSServiceName"
        values   = ["ses.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_policy" "worker" {
  for_each = data.aws_iam_policy_document.worker

  name   = "${local.name_prefix}-${each.key}"
  policy = each.value.json
  tags   = local.tags
}

resource "aws_iam_role_policy_attachment" "worker" {
  for_each = {
    for key, role_name in var.lambda_role_names : key => role_name
    if contains(keys(var.lambda_function_arns), key)
  }

  policy_arn = aws_iam_policy.worker[each.key].arn
  role       = each.value
}

resource "aws_lambda_event_source_mapping" "queue" {
  for_each = {
    for key in ["events", "inbound", "send"] : key => var.lambda_function_arns[key]
    if(
      contains(keys(var.lambda_function_arns), key) &&
      contains(keys(var.lambda_role_names), key) &&
      !(key == "inbound" && local.inbound_runtime_configured) &&
      !(local.runtime_configured && contains(["events", "send"], key))
    )
  }

  batch_size                         = each.key == "inbound" ? 5 : 10
  event_source_arn                   = aws_sqs_queue.worker[each.key].arn
  function_name                      = each.value
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 1

  depends_on = [aws_iam_role_policy_attachment.worker]
}

resource "aws_lambda_event_source_mapping" "events_stream" {
  count = !local.runtime_configured && contains(keys(var.lambda_function_arns), "stream-dispatcher") && contains(keys(var.lambda_role_names), "stream-dispatcher") && var.events_stream_arn != "" ? 1 : 0

  batch_size                         = 100
  bisect_batch_on_function_error     = true
  event_source_arn                   = var.events_stream_arn
  function_name                      = var.lambda_function_arns["stream-dispatcher"]
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_retry_attempts             = 10
  parallelization_factor             = 2
  starting_position                  = "TRIM_HORIZON"
  maximum_batching_window_in_seconds = 1

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.stream_dispatcher_dlq.arn
    }
  }

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT"]
        dynamodb = {
          NewImage = {
            data = {
              M = {
                eventType = {
                  S = ["agent-email.send-requested"]
                }
              }
            }
            itemType = {
              S = ["semantic-event"]
            }
          }
        }
      })
    }
  }

  depends_on = [aws_iam_role_policy_attachment.worker]
}

data "aws_iam_policy_document" "scheduler_assume" {
  count = !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") && contains(keys(var.lambda_role_names), "maintenance") ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count = !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") && contains(keys(var.lambda_role_names), "maintenance") ? 1 : 0

  name                 = "${local.name_prefix}-maintenance-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_assume[0].json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "scheduler" {
  count = !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") && contains(keys(var.lambda_role_names), "maintenance") ? 1 : 0

  role = aws_iam_role.scheduler[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "lambda:InvokeFunction"
      Effect   = "Allow"
      Resource = var.lambda_function_arns["maintenance"]
    }]
  })
}

resource "aws_scheduler_schedule" "maintenance" {
  count = !local.runtime_configured && contains(keys(var.lambda_function_arns), "maintenance") && contains(keys(var.lambda_role_names), "maintenance") ? 1 : 0

  name                = "${local.name_prefix}-maintenance"
  schedule_expression = "rate(1 minute)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.lambda_function_arns["maintenance"]
    role_arn = aws_iam_role.scheduler[0].arn
  }

  depends_on = [aws_iam_role_policy_attachment.worker]
}

resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each = var.alarms_enabled ? aws_sqs_queue.dlq : {}

  alarm_name          = "${local.name_prefix}-${each.key}-dlq-visible"
  alarm_description   = "Agent email ${each.key} dead-letter queue contains messages."
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

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "stream_dispatcher_dlq" {
  alarm_name          = "${local.name_prefix}-stream-dispatcher-dlq-visible"
  alarm_description   = "Agent email stream dispatcher dead-letter queue contains messages."
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
    QueueName = aws_sqs_queue.stream_dispatcher_dlq.name
  }

  tags = local.tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
