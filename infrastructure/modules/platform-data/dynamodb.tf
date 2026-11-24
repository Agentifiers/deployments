resource "aws_dynamodb_table" "platform" {
  for_each = local.tables

  name         = each.key
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  deletion_protection_enabled = var.deletion_protection_enabled
  stream_enabled              = each.value.stream_enabled
  stream_view_type            = each.value.stream_enabled ? "NEW_AND_OLD_IMAGES" : null

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  dynamic "attribute" {
    for_each = toset(flatten([
      for index in values(each.value.global_secondary_indexes) : [index.hash_key, index.range_key]
    ]))

    content {
      name = attribute.value
      type = "S"
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.value.global_secondary_indexes

    content {
      name            = global_secondary_index.key
      projection_type = "ALL"

      key_schema {
        attribute_name = global_secondary_index.value.hash_key
        key_type       = "HASH"
      }

      key_schema {
        attribute_name = global_secondary_index.value.range_key
        key_type       = "RANGE"
      }
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  # enabled = false selects the AWS owned key; omitting the block would keep a prior key.
  server_side_encryption {
    enabled = false
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = merge(local.common_tags, {
    Name = each.key
  })
}

resource "aws_cloudwatch_metric_alarm" "throttled_requests" {
  for_each = var.alarms_enabled ? local.throttle_alarms : {}

  alarm_name          = "${each.value.table}-${lower(each.value.operation)}-throttled"
  alarm_description   = "DynamoDB ${each.value.operation} requests on ${each.value.table} are throttling."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ThrottledRequests"
  namespace           = "AWS/DynamoDB"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    Operation = each.value.operation
    TableName = each.value.table
  }

  tags = local.common_tags
}
