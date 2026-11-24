resource "aws_athena_workgroup" "events" {
  name          = "semantic-events"
  description   = "Query the standalone platform semantic event Iceberg projection."
  force_destroy = !var.storage_deletion_protection_enabled || var.destructive_cleanup_enabled
  tags          = local.common_tags

  configuration {
    bytes_scanned_cutoff_per_query     = var.athena_bytes_scanned_cutoff
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.athena_results.id}/results/"
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

resource "aws_athena_named_query" "recent_events" {
  name        = "recent_semantic_events"
  description = "Recent semantic events deduplicated by canonical event ID."
  database    = aws_glue_catalog_database.query_context.name
  workgroup   = aws_athena_workgroup.events.name
  query       = <<-SQL
    WITH ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY event_id
        ORDER BY ingested_at DESC, eventbridge_event_id DESC
      ) AS delivery_rank
      FROM ${local.athena_table_ref}
      WHERE from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '7' day
        AND from_iso8601_timestamp(occurred_at) <= current_timestamp
    )
    SELECT event_id, event_type, event_source, organization_id, project_id,
           environment_id, aggregate_type, aggregate_id, aggregate_version,
           actor_id, actor_type, occurred_at, ingested_at, trace_id,
           payload_json
    FROM ranked
    WHERE delivery_rank = 1
    ORDER BY ingested_at DESC, event_id DESC
    LIMIT 100;
  SQL
}

resource "aws_athena_named_query" "event_type_counts" {
  name        = "semantic_event_type_counts_24h"
  description = "Deduplicated semantic event counts by type over the last 24 hours."
  database    = aws_glue_catalog_database.query_context.name
  workgroup   = aws_athena_workgroup.events.name
  query       = <<-SQL
    WITH ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY event_id
        ORDER BY ingested_at DESC, eventbridge_event_id DESC
      ) AS delivery_rank
      FROM ${local.athena_table_ref}
      WHERE from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '24' hour
        AND from_iso8601_timestamp(occurred_at) <= current_timestamp
    )
    SELECT event_type, count(*) AS event_count
    FROM ranked
    WHERE delivery_rank = 1
    GROUP BY event_type
    ORDER BY event_count DESC, event_type ASC;
  SQL
}

resource "aws_cloudwatch_metric_alarm" "projector_errors" {
  alarm_name          = "${local.name_prefix}-projector-errors"
  alarm_description   = "The semantic event analytics projector Lambda is returning errors."
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
  dimensions = {
    FunctionName = aws_lambda_function.projector.function_name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "projector_dlq" {
  alarm_name          = "${local.name_prefix}-projector-dlq"
  alarm_description   = "One or more semantic events exhausted analytical projection retries."
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
    QueueName = aws_sqs_queue.projector_dlq.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "projector_lambda_dlq_delivery_errors" {
  alarm_name          = "${local.name_prefix}-projector-lambda-dlq-delivery-errors"
  alarm_description   = "Lambda could not retain an exhausted semantic event in the projector DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DeadLetterErrors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    FunctionName = aws_lambda_function.projector.function_name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "projector_eventbridge_dlq_delivery_errors" {
  alarm_name          = "${local.name_prefix}-projector-eventbridge-dlq-delivery-errors"
  alarm_description   = "EventBridge could not retain an undeliverable semantic event in the projector DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "InvocationsFailedToBeSentToDlq"
  namespace           = "AWS/Events"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    EventBusName = var.event_bus_name
    RuleName     = aws_cloudwatch_event_rule.projector.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "firehose_freshness" {
  alarm_name          = "${local.name_prefix}-firehose-freshness"
  alarm_description   = "Firehose has not committed semantic event records to Iceberg within fifteen minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "DeliveryToIceberg.DataFreshness"
  namespace           = "AWS/Firehose"
  period              = 300
  statistic           = "Maximum"
  threshold           = 900
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    DeliveryStreamName = aws_kinesis_firehose_delivery_stream.events.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "firehose_failed_rows" {
  alarm_name          = "${local.name_prefix}-firehose-failed-rows"
  alarm_description   = "Firehose rejected one or more semantic event rows while delivering to Iceberg."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DeliveryToIceberg.FailedRowCount"
  namespace           = "AWS/Firehose"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    DeliveryStreamName = aws_kinesis_firehose_delivery_stream.events.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
