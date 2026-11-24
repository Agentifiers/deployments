output "athena_workgroup_name" {
  description = "Bounded Athena workgroup for observability reconciliation and rebuild queries."
  value       = aws_athena_workgroup.observability.name
}

output "backup_bucket_name" {
  description = "Encrypted bucket containing Firehose rows that failed Iceberg delivery."
  value       = aws_s3_bucket.runtime["backup"].id
}

output "failure_queue_urls" {
  description = "Encrypted exhausted-record queues by observability consumer."
  value       = { for name, queue in aws_sqs_queue.failures : name => queue.url }
}

output "fact_stream_arn" {
  description = "Kinesis stream carrying normalized observability facts."
  value       = aws_kinesis_stream.facts.arn
}

output "projector_checkpoint_table_name" {
  description = "DynamoDB table containing contiguous canonical-projector checkpoints by Kinesis shard."
  value       = aws_dynamodb_table.projector_checkpoints.name
}

output "projector_event_source_mapping_uuid" {
  description = "Lambda event-source mapping UUID used to quiesce the canonical projector during rebuilds."
  value       = aws_lambda_event_source_mapping.projector.uuid
}

output "firehose_stream_names" {
  description = "Iceberg Firehose delivery stream names by fact family."
  value       = { for name, stream in aws_kinesis_firehose_delivery_stream.history : name => stream.name }
}

output "quarantine_bucket_name" {
  description = "Encrypted bucket containing malformed canonical source records for recovery."
  value       = aws_s3_bucket.runtime["quarantine"].id
}

output "quarantine_bucket_arn" {
  description = "ARN of the encrypted bucket containing tenant-scoped malformed source records."
  value       = aws_s3_bucket.runtime["quarantine"].arn
}

output "rebuild_query_id" {
  description = "Athena named-query ID for the deduplicated tombstone-aware rebuild export."
  value       = aws_athena_named_query.rebuild_export.id
}

output "clickhouse_rebuild_query_id" {
  description = "Athena named-query ID for the retention-bounded disposable ClickHouse rebuild export."
  value       = aws_athena_named_query.clickhouse_rebuild_export.id
}

output "reconciliation_query_id" {
  description = "Athena named-query ID for trace and usage reconciliation."
  value       = aws_athena_named_query.trace_reconciliation.id
}

output "watermark_query_id" {
  description = "Athena named-query ID for committed cold-history watermarks."
  value       = aws_athena_named_query.source_watermarks.id
}

output "erasure_athena_workgroup_name" {
  description = "SSE_S3 Athena workgroup running tenant-erasure DML over observability history."
  value       = aws_athena_workgroup.erasure.name
}

output "erasure_function_arn" {
  description = "ARN of the observability tenant-erasure Lambda invoked by the governance worker."
  value       = aws_lambda_function.erasure.arn
}

output "erasure_function_name" {
  description = "Name of the observability tenant-erasure Lambda invoked by the governance worker."
  value       = aws_lambda_function.erasure.function_name
}
