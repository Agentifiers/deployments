output "api_base_url" {
  description = "Private authenticated hot-plane API base URL."
  value       = "http://hot-plane.observability.internal:3000"
}

output "checkpoint_table_name" {
  description = "Durable Kinesis checkpoint table used by the stateless hot writer."
  value       = aws_dynamodb_table.checkpoints.name
}

output "clickhouse_host" {
  description = "Private TLS ClickHouse hostname."
  value       = local.database_host
}

output "data_volume_id" {
  description = "Literal durable EBS data-volume ID used during replacement and recovery."
  value       = local.data_volume_id
}

output "instance_id" {
  description = "Current ClickHouse EC2 instance ID."
  value       = aws_instance.node.id
}

output "runtime_secret_arn" {
  description = "SecureString parameter ARNs containing ClickHouse TLS and database user material."
  value       = { for name, parameter in aws_ssm_parameter.runtime : name => parameter.arn }
}

output "service_secret_arn" {
  description = "SecureString parameter containing only the internal hot-plane API service credential."
  value       = aws_ssm_parameter.service.arn
}

output "service_secret_version_id" {
  description = "Parameter version pinned into both ECS and the public API Lambda configuration."
  value       = tostring(aws_ssm_parameter.service.version)
}

output "service_name" {
  description = "Hot-plane ECS service name."
  value       = aws_ecs_service.hot.name
}

output "cluster_arn" {
  description = "Hot-plane ECS cluster ARN."
  value       = aws_ecs_cluster.hot.arn
}

output "backup_bucket_name" {
  description = "Versioned native ClickHouse backup bucket."
  value       = aws_s3_bucket.backups.id
}

output "backup_expiry_days" {
  description = "Upper bounds, in days after a backup is taken, until native ClickHouse backups and EBS snapshots are deleted."
  value = {
    native_backup = local.native_backup_retention_days
    # Snapshots are swept by the daily backup association, so add one cadence.
    ebs_snapshot = local.snapshot_retention_days + 1
  }
}
