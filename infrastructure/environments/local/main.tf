# Development-only values for the local AWS emulator; never apply this root to real AWS.
locals {
  memory_cursor_key_hex = "6465706c6f796d656e74732d61692d6c6f63616c2d6d656d6f72792d63757273"
  tenant_limit_defaults_json = jsonencode({
    api_requests_per_second = 20
    api_request_burst       = 40
    concurrent_runs         = 8
    active_sandboxes        = 8
  })

  tables = {
    control               = false
    events                = true
    execution             = false
    identity              = false
    identity-email-outbox = false
    usage                 = true
  }

  queues = {
    agent-run = {
      max_receive_count          = 900
      visibility_timeout_seconds = 900
    }
    agent-email-events = {
      max_receive_count          = 5
      visibility_timeout_seconds = 360
    }
    agent-email-inbound = {
      max_receive_count          = 5
      visibility_timeout_seconds = 900
    }
    agent-email-send = {
      max_receive_count          = 5
      visibility_timeout_seconds = 900
    }
    channel-delivery = {
      max_receive_count          = 5
      visibility_timeout_seconds = 120
    }
    channel-ingress = {
      max_receive_count          = 5
      visibility_timeout_seconds = 120
    }
    channel-ingress-flush = {
      max_receive_count          = 5
      visibility_timeout_seconds = 370
    }
    memory-flush = {
      max_receive_count          = 5
      visibility_timeout_seconds = 360
    }
    memory-cleanup = {
      max_receive_count          = 5
      visibility_timeout_seconds = 360
    }
    memory-index = {
      max_receive_count          = 5
      visibility_timeout_seconds = 180
    }
    memory-operation = {
      max_receive_count          = 5
      visibility_timeout_seconds = 1020
    }
    memory-reconcile = {
      max_receive_count          = 5
      visibility_timeout_seconds = 360
    }
    memory-shadow = {
      max_receive_count          = 5
      visibility_timeout_seconds = 180
    }
    memory-usage = {
      max_receive_count          = 5
      visibility_timeout_seconds = 180
    }
    provider-tools = {
      max_receive_count          = 5
      visibility_timeout_seconds = 360
    }
  }

  secret_names = toset([
    "end-user-subject-key",
    "memory-membership-hmac-key",
  ])
  memory_queue_events = {
    memory-cleanup   = ["memory.blob-cleanup.requested", "memory.review-content-cleanup.requested"]
    memory-flush     = ["memory.flush.queued"]
    memory-index     = ["memory.index.queued"]
    memory-shadow    = ["memory.shadow.queued"]
    memory-reconcile = ["memory.reconcile.requested", "memory-space.archived", "memory.reconcile.continuation"]
  }
}

resource "aws_dynamodb_table" "platform" {
  for_each = local.tables

  name         = each.key
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  stream_enabled   = each.value
  stream_view_type = each.value ? "NEW_AND_OLD_IMAGES" : null

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  global_secondary_index {
    name            = "gsi2"
    projection_type = "ALL"

    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

resource "aws_cloudwatch_event_bus" "semantic" {
  name = "semantic-events"
}

resource "aws_cloudwatch_event_rule" "memory_queue" {
  for_each = local.memory_queue_events

  name           = each.key
  event_bus_name = aws_cloudwatch_event_bus.semantic.name
  event_pattern = jsonencode({
    source        = ["deployments-ai.platform"]
    "detail-type" = each.value
  })
}

resource "aws_cloudwatch_event_target" "memory_queue" {
  for_each = aws_cloudwatch_event_rule.memory_queue

  event_bus_name = aws_cloudwatch_event_bus.semantic.name
  rule           = each.value.name
  arn            = aws_sqs_queue.runtime[each.key].arn
  target_id      = each.key
}

data "aws_iam_policy_document" "memory_queue" {
  for_each = aws_cloudwatch_event_rule.memory_queue

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runtime[each.key].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [each.value.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "memory_queue" {
  for_each = data.aws_iam_policy_document.memory_queue

  queue_url = aws_sqs_queue.runtime[each.key].url
  policy    = each.value.json
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "artifacts"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket" "agent_email" {
  bucket        = "agent-email"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "agent_email" {
  bucket = aws_s3_bucket.agent_email.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_sqs_queue" "dlq" {
  for_each = local.queues

  name                       = "${each.key}-dlq${contains(["agent-run", "channel-ingress"], each.key) ? ".fifo" : ""}"
  fifo_queue                 = contains(["agent-run", "channel-ingress"], each.key)
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = each.value.visibility_timeout_seconds
}

resource "aws_sqs_queue" "runtime" {
  for_each = local.queues

  name                       = "${each.key}${contains(["agent-run", "channel-ingress"], each.key) ? ".fifo" : ""}"
  fifo_queue                 = contains(["agent-run", "channel-ingress"], each.key)
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  visibility_timeout_seconds = each.value.visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })
}

resource "aws_secretsmanager_secret" "runtime" {
  for_each = local.secret_names

  name                    = each.key
  recovery_window_in_days = 0
}

resource "random_password" "memory_membership" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret_version" "memory_membership" {
  secret_id = aws_secretsmanager_secret.runtime["memory-membership-hmac-key"].id
  secret_string = jsonencode({
    currentVersion = 1
    keys = {
      "1" = random_password.memory_membership.result
    }
  })
}

resource "aws_dynamodb_table" "request_admission" {
  name         = "request-admission"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

resource "random_password" "end_user_subject" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret_version" "end_user_subject" {
  secret_id     = aws_secretsmanager_secret.runtime["end-user-subject-key"].id
  secret_string = random_password.end_user_subject.result
}
