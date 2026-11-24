output "athena_catalog_name" {
  description = "Nested Glue catalog exposing the stage S3 table bucket to Athena."
  value       = local.s3tables_child_catalog_name
}

output "athena_database_name" {
  description = "S3 Tables namespace containing the semantic event projection."
  value       = var.s3_table_namespace
}

output "athena_workgroup_name" {
  description = "Athena workgroup for semantic event queries."
  value       = aws_athena_workgroup.events.name
}

output "athena_query" {
  description = "Coordinates the operator event analytics script and MCP server read to query the semantic event log."
  value = {
    catalog_name    = local.s3tables_child_catalog_name
    database_name   = var.s3_table_namespace
    output_location = "s3://${aws_s3_bucket.athena_results.id}/results/"
    region          = data.aws_region.current.region
    table_name      = var.s3_table_name
    workgroup_name  = aws_athena_workgroup.events.name
  }
}

output "firehose_delivery_stream_arn" {
  description = "Firehose stream writing the semantic event Iceberg projection."
  value       = aws_kinesis_firehose_delivery_stream.events.arn
}

output "operator_query_policy_arn" {
  description = "Managed policy granting operators read-only Athena access to the cross-tenant semantic event log."
  value       = aws_iam_policy.operator_query.arn
}

output "projector_function_arn" {
  description = "EventBridge analytical projector Lambda ARN."
  value       = aws_lambda_function.projector.arn
}

output "s3_table_bucket_arn" {
  description = "S3 Tables bucket ARN written by Firehose and read by Athena."
  value       = var.s3_table_bucket_arn
}

output "s3_table_arn" {
  description = "Semantic event Iceberg table ARN."
  value       = var.s3_table_arn
}
