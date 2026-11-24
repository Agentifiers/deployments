output "kms_key_arn" {
  description = "Shared customer managed KMS key for artifact, governance, and content objects, application envelope encryption, and service integrations that require a customer managed key."
  value       = local.data_kms_key_arn
}

output "artifact_bucket_arn" {
  description = "Private S3 bucket ARN for platform artifacts and screenshots."
  value       = local.artifact_bucket_arn
}

output "artifact_bucket_name" {
  description = "Private S3 bucket name for platform artifacts and screenshots."
  value       = local.artifact_bucket_id
}

output "ingress_attachment_capture_role_arn" {
  description = "Role that channel and email ingress assume, tagged with one tenant's scope, to store captured attachments and their extracted text under that tenant's customer artifact prefix. Null while no ingress role may assume it."
  value       = one(aws_iam_role.ingress_attachment_capture[*].arn)
}

output "governance_bucket_arn" {
  description = "Private Object Lock bucket ARN for tenant and immutable audit exports."
  value       = local.governance_bucket_arn
}

output "governance_bucket_name" {
  description = "Private Object Lock bucket name for tenant and immutable audit exports."
  value       = local.governance_bucket_id
}

output "governance_signing_key_arn" {
  description = "Asymmetric KMS key ARN used to sign immutable audit export manifests."
  value       = local.governance_signing_key_arn
}

output "s3tables_catalog_arn" {
  description = "Account-level Glue catalog ARN for S3 Tables integrations."
  value       = local.s3tables_catalog_arn
}

output "s3tables_catalog_name" {
  description = "Account-level Glue catalog name for S3 Tables integrations."
  value       = "s3tablescatalog"
}

output "agent_observability_table_arns" {
  description = "Protected agent observability Iceberg table ARNs by logical fact family."
  value = merge(
    { for name, table in aws_s3tables_table.agent_observability_unprotected : name => table.arn },
    { for name, table in aws_s3tables_table.agent_observability_protected : name => table.arn },
  )
}

output "agent_observability_table_names" {
  description = "Agent observability Iceberg table names by logical fact family."
  value = merge(
    { for name, table in aws_s3tables_table.agent_observability_unprotected : name => table.name },
    { for name, table in aws_s3tables_table.agent_observability_protected : name => table.name },
  )
}

output "agent_observability_table_bucket_arn" {
  description = "S3 Tables bucket ARN containing normalized agent observability history."
  value       = one(aws_s3tables_table_bucket.agent_observability[*].arn)
}

output "agent_observability_table_bucket_name" {
  description = "S3 Tables bucket name containing normalized agent observability history."
  value       = one(aws_s3tables_table_bucket.agent_observability[*].name)
}

output "agent_observability_table_namespace" {
  description = "Namespace containing normalized agent observability history."
  value       = one(aws_s3tables_namespace.agent_observability[*].namespace)
}

output "agent_observability_physical_removal" {
  description = "Pinned S3 Tables maintenance settings bounding physical removal of erased observability history."
  value = {
    noncurrent_file_days   = var.agent_observability_noncurrent_file_days
    snapshot_max_age_hours = var.agent_observability_snapshot_max_age_hours
    unreferenced_file_days = var.agent_observability_unreferenced_file_days
  }
}

output "semantic_event_table_arn" {
  description = "Protected semantic event Iceberg table ARN."
  value       = local.semantic_event_table_arn
}

output "semantic_event_table_bucket_arn" {
  description = "S3 Tables bucket ARN containing the semantic event history."
  value       = aws_s3tables_table_bucket.semantic_events.arn
}

output "semantic_event_table_bucket_name" {
  description = "S3 Tables bucket name containing the semantic event history."
  value       = aws_s3tables_table_bucket.semantic_events.name
}

output "semantic_event_table_name" {
  description = "Semantic event Iceberg table name."
  value       = local.semantic_event_table_name
}

output "semantic_event_table_namespace" {
  description = "Semantic event Iceberg namespace."
  value       = aws_s3tables_namespace.semantic_events.namespace
}

output "table_arns" {
  description = "Platform DynamoDB table ARNs keyed by stable table name."
  value       = { for name, table in aws_dynamodb_table.platform : name => table.arn }
}

output "table_names" {
  description = "Platform DynamoDB table names."
  value       = { for name, table in aws_dynamodb_table.platform : name => table.name }
}

output "table_stream_arns" {
  description = "DynamoDB Stream ARNs for stream-enabled tables."
  value = {
    for name, table in aws_dynamodb_table.platform : name => table.stream_arn
    if table.stream_enabled
  }
}

output "request_admission_table_arn" {
  description = "ARN of the per-organization request admission table."
  value       = aws_dynamodb_table.request_admission.arn
}

output "request_admission_table_name" {
  description = "Name of the per-organization request admission table."
  value       = aws_dynamodb_table.request_admission.name
}
