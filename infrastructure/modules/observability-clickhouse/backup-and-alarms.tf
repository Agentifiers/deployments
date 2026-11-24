locals {
  # Days a native BACKUP object stays readable: current-version expiration plus
  # one noncurrent day. Tenant erasure reports backup expiry from these values.
  native_backup_retention_days = var.backup_retention_in_days
  # The daily backup association deletes snapshots older than this many days.
  snapshot_retention_days = var.backup_retention_in_days
}

resource "aws_s3_bucket" "backups" {
  bucket        = "agent-observability-clickhouse-backups-${data.aws_caller_identity.current.account_id}"
  force_destroy = !var.deletion_protection_enabled
  tags          = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "bounded-retention"
    status = "Enabled"
    filter {}
    expiration { days = local.native_backup_retention_days - 1 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
}

resource "aws_ssm_association" "native_backup" {
  name                        = "AWS-RunShellScript"
  association_name            = "${local.name_prefix}-native-backup"
  schedule_expression         = "cron(15 3 * * ? *)"
  apply_only_at_cron_interval = true
  targets {
    key    = "InstanceIds"
    values = [aws_instance.node.id]
  }
  parameters = {
    commands = join("\n", [
      "script_path=$(mktemp /run/agent-observability-backup.XXXXXX)",
      "chmod 0700 \"$script_path\"",
      "cat > \"$script_path\" <<'OBSERVABILITY_BACKUP'",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "started_at=$(date -u +%s)",
      "backup_name=hot-$(date -u +%Y%m%dT%H%M%SZ)",
      "clickhouse-client --config-file /root/.clickhouse-client/config.xml --query=\"BACKUP DATABASE observability TO S3('https://${aws_s3_bucket.backups.id}.s3.${data.aws_region.current.region}.amazonaws.com/native/$backup_name')\"",
      "snapshot_id=$(aws ec2 create-snapshot --region '${data.aws_region.current.region}' --volume-id '${local.data_volume_id}' --description \"$backup_name\" --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Runtime,Value=agent-observability},{Key=Environment,Value=${var.environment}},{Key=ManagedBy,Value=ssm-backup},{Key=SourceVolumeId,Value=${local.data_volume_id}}]' --query SnapshotId --output text)",
      "aws ec2 wait snapshot-completed --region '${data.aws_region.current.region}' --snapshot-ids \"$snapshot_id\"",
      "snapshot_state=$(aws ec2 describe-snapshots --region '${data.aws_region.current.region}' --snapshot-ids \"$snapshot_id\" --query 'Snapshots[0].State' --output text)",
      "[[ \"$snapshot_state\" == \"completed\" ]] || { printf 'Snapshot %s entered state %s\\n' \"$snapshot_id\" \"$snapshot_state\" >&2; exit 1; }",
      "retention_days=${local.snapshot_retention_days}",
      "cutoff_epoch=$(date -u -d \"$retention_days days ago\" +%s)",
      "while read -r snapshot start_time; do",
      "  [[ -z \"$snapshot\" || -z \"$start_time\" || \"$snapshot\" == \"None\" ]] && continue",
      "  start_epoch=$(date -u -d \"$start_time\" +%s)",
      "  if (( start_epoch < cutoff_epoch )); then aws ec2 delete-snapshot --region '${data.aws_region.current.region}' --snapshot-id \"$snapshot\"; fi",
      "done < <(aws ec2 describe-snapshots --region '${data.aws_region.current.region}' --owner-ids self --filters 'Name=tag:Runtime,Values=agent-observability' 'Name=tag:Environment,Values=${var.environment}' 'Name=tag:ManagedBy,Values=ssm-backup' 'Name=tag:SourceVolumeId,Values=${local.data_volume_id}' 'Name=volume-id,Values=${local.data_volume_id}' --query 'Snapshots[].[SnapshotId,StartTime]' --output text)",
      "printf '%s\\n' \"$started_at\" > /var/lib/agent-observability/backup-started-at",
      "printf '%s\\n' \"$snapshot_id\"",
      "OBSERVABILITY_BACKUP",
      "/usr/bin/env bash \"$script_path\"; status=$?; rm -f \"$script_path\"; exit $status",
    ])
  }
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "${local.name_prefix}-instance-status"
  alarm_description   = "The ClickHouse EC2 node failed an instance or system status check."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { InstanceId = aws_instance.node.id }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "instance_cpu" {
  alarm_name          = "${local.name_prefix}-cpu"
  alarm_description   = "ClickHouse CPU has remained above 90 percent."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 90
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { InstanceId = aws_instance.node.id }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

# An unlimited t4g node that runs above its baseline long enough to exhaust its earned credits pays
# for surplus credits; any charge in an hour is a sign the node should move to a larger size.
resource "aws_cloudwatch_metric_alarm" "instance_cpu_surplus_credits" {
  count               = var.alarms_enabled && local.burstable ? 1 : 0
  alarm_name          = "${local.name_prefix}-cpu-surplus-credits"
  alarm_description   = "The burstable ClickHouse node is paying for surplus CPU credits; sustained load exceeds its baseline."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "CPUSurplusCreditsCharged"
  namespace           = "AWS/EC2"
  period              = 3600
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { InstanceId = aws_instance.node.id }
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "service_cpu" {
  alarm_name          = "${local.name_prefix}-service-cpu"
  alarm_description   = "The observability writer/query task is CPU constrained."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 90
  treat_missing_data  = var.desired_count == 0 ? "notBreaching" : "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.hot.name
    ServiceName = aws_ecs_service.hot.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "service_memory" {
  alarm_name          = "${local.name_prefix}-service-memory"
  alarm_description   = "The observability writer/query task is memory constrained."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 90
  treat_missing_data  = var.desired_count == 0 ? "notBreaching" : "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.hot.name
    ServiceName = aws_ecs_service.hot.name
  }
  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "data_volume_usage" {
  alarm_name          = "${local.name_prefix}-data-volume-usage"
  alarm_description   = "The ClickHouse data volume has stayed more than 80 percent full for 15 minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DataVolumeUsedPercent"
  namespace           = "DeploymentsAI/Observability"
  period              = 300
  statistic           = "Maximum"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { Environment = var.environment }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

# The daily backup starts at 03:15 UTC, so the last successful start is at most 24 hours old when
# the next one begins. Above 26 hours, a run failed, did not run, or is still going 2 hours in.
resource "aws_cloudwatch_metric_alarm" "backup" {
  alarm_name          = "${local.name_prefix}-backup"
  alarm_description   = "No ClickHouse backup has succeeded in the last 26 hours, or the node has stopped reporting its backup age for 30 minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 6
  metric_name         = "BackupAgeHours"
  namespace           = "DeploymentsAI/Observability"
  period              = 300
  statistic           = "Maximum"
  threshold           = 26
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { Environment = var.environment }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_dashboard" "hot" {
  dashboard_name = local.name_prefix
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6,
        properties = {
          title = "ClickHouse EC2", region = data.aws_region.current.region, view = "timeSeries",
          metrics = [
            ["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.node.id],
            [".", "StatusCheckFailed", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6,
        properties = {
          title = "Hot-plane service", region = data.aws_region.current.region, view = "timeSeries",
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.hot.name, "ServiceName", aws_ecs_service.hot.name],
            [".", "MemoryUtilization", ".", ".", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6,
        properties = {
          title = "ClickHouse disk and backups", region = data.aws_region.current.region, view = "timeSeries",
          metrics = [
            ["DeploymentsAI/Observability", "DataVolumeUsedPercent", "Environment", var.environment],
            [".", "BackupAgeHours", ".", "."],
          ]
        }
      }
    ]
  })
}
