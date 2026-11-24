locals {
  observability_common_columns = [
    { name = "fact_id", type = "string" },
    { name = "fact_type", type = "string" },
    { name = "schema_version", type = "long" },
    { name = "redaction_policy_version", type = "long" },
    { name = "capture_mode", type = "string" },
    { name = "organization_id", type = "string" },
    { name = "project_id", type = "string" },
    { name = "environment_id", type = "string" },
    { name = "workspace_id", type = "string" },
    { name = "trace_id", type = "string" },
    { name = "span_id", type = "string" },
    { name = "parent_span_id", type = "string" },
    { name = "run_id", type = "string" },
    { name = "session_id", type = "string" },
    { name = "source_table", type = "string" },
    { name = "source_record_type", type = "string" },
    { name = "source_record_id", type = "string" },
    { name = "source_record_version", type = "long" },
    { name = "source_stream_arn", type = "string" },
    { name = "source_stream_sequence_number", type = "string" },
    { name = "occurred_at", type = "string" },
    { name = "normalized_at", type = "string" },
    { name = "projected_at", type = "string" },
    { name = "projection_stream_arn", type = "string" },
    { name = "projection_shard_id", type = "string" },
    { name = "projection_sequence_number", type = "string" },
    { name = "payload_json", type = "string" },
  ]
  observability_table_columns = {
    spans = concat(local.observability_common_columns, [
      { name = "span_kind", type = "string" },
      { name = "span_name", type = "string" },
      { name = "span_status", type = "string" },
      { name = "started_at", type = "string" },
      { name = "ended_at", type = "string" },
      { name = "duration_ms", type = "double" },
      { name = "error_class", type = "string" },
      { name = "requested_model_id", type = "string" },
      { name = "requested_provider", type = "string" },
      { name = "actual_model_id", type = "string" },
      { name = "actual_provider", type = "string" },
      { name = "tool_effect", type = "string" },
      { name = "input_tokens", type = "long" },
      { name = "output_tokens", type = "long" },
      { name = "cached_tokens", type = "long" },
      { name = "total_tokens", type = "long" },
      { name = "cost_usd_micros", type = "long" },
      { name = "provider_request_id", type = "string" },
      { name = "stop_reason", type = "string" },
    ])
    traces = concat(local.observability_common_columns, [
      { name = "root_run_id", type = "string" },
      { name = "trace_status", type = "string" },
      { name = "completed_at", type = "string" },
      { name = "finalized_at", type = "string" },
      { name = "graph_watermark", type = "string" },
      { name = "run_count", type = "long" },
      { name = "total_tokens", type = "long" },
      { name = "total_cost_usd_micros", type = "long" },
    ])
    "model-invocations" = concat(local.observability_common_columns, [
      { name = "invocation_id", type = "string" },
      { name = "attempt_id", type = "string" },
      { name = "invocation_status", type = "string" },
      { name = "started_at", type = "string" },
      { name = "ended_at", type = "string" },
      { name = "duration_ms", type = "double" },
      { name = "requested_model_id", type = "string" },
      { name = "requested_provider", type = "string" },
      { name = "actual_model_id", type = "string" },
      { name = "actual_provider", type = "string" },
      { name = "fallback_attempt", type = "long" },
      { name = "fallback_reason", type = "string" },
      { name = "error_class", type = "string" },
      { name = "streaming", type = "boolean" },
      { name = "internal_evaluator", type = "boolean" },
      { name = "input_tokens", type = "long" },
      { name = "output_tokens", type = "long" },
      { name = "cached_tokens", type = "long" },
      { name = "total_tokens", type = "long" },
      { name = "cost_usd_micros", type = "long" },
      { name = "usage_idempotency_key", type = "string" },
      { name = "provider_request_id", type = "string" },
      { name = "stop_reason", type = "string" },
      { name = "agent_definition_id", type = "string" },
      { name = "agent_deployment_id", type = "string" },
      { name = "agent_release_id", type = "string" },
      { name = "agent_manifest_hash", type = "string" },
    ])
    usage = concat(local.observability_common_columns, [
      { name = "usage_idempotency_key", type = "string" },
      { name = "metric", type = "string" },
      { name = "unit", type = "string" },
      { name = "quantity", type = "double" },
      { name = "usage_source", type = "string" },
      { name = "model_id", type = "string" },
      { name = "provider", type = "string" },
      { name = "cost_usd_micros", type = "long" },
      { name = "started_at", type = "string" },
    ])
    tombstones = concat(local.observability_common_columns, [
      { name = "deleted_at", type = "string" },
      { name = "delete_through_record_version", type = "long" },
      { name = "deleted_fact_types_json", type = "string" },
    ])
  }
}

# Tenant erasure reports a physical-removal bound computed from these pinned
# maintenance settings (see the agent-observability erasure Lambda inputs).
locals {
  observability_table_maintenance = {
    iceberg_compaction = {
      settings = { target_file_size_mb = 512 }
      status   = "enabled"
    }
    iceberg_snapshot_management = {
      settings = {
        max_snapshot_age_hours = var.agent_observability_snapshot_max_age_hours
        min_snapshots_to_keep  = 1
      }
      status = "enabled"
    }
  }
}

resource "aws_s3tables_table_bucket" "agent_observability" {
  count         = var.agent_observability_history_enabled ? 1 : 0
  name          = "agent-observability"
  force_destroy = !var.deletion_protection_enabled
  encryption_configuration = {
    sse_algorithm = "AES256"
    kms_key_arn   = null
  }
  maintenance_configuration = {
    iceberg_unreferenced_file_removal = {
      settings = {
        non_current_days  = var.agent_observability_noncurrent_file_days
        unreferenced_days = var.agent_observability_unreferenced_file_days
      }
      status = "enabled"
    }
  }
  tags = merge(local.common_tags, { Name = "agent-observability" })
}

resource "aws_s3tables_namespace" "agent_observability" {
  count            = var.agent_observability_history_enabled ? 1 : 0
  namespace        = "agent_observability"
  table_bucket_arn = aws_s3tables_table_bucket.agent_observability[0].arn
}

resource "aws_s3tables_table" "agent_observability_unprotected" {
  for_each = var.agent_observability_history_enabled && !var.deletion_protection_enabled ? local.observability_table_columns : {}

  name             = replace(each.key, "-", "_")
  namespace        = aws_s3tables_namespace.agent_observability[0].namespace
  table_bucket_arn = aws_s3tables_table_bucket.agent_observability[0].arn
  format           = "ICEBERG"

  maintenance_configuration = local.observability_table_maintenance

  metadata {
    iceberg {
      schema {
        dynamic "field" {
          for_each = each.value
          content {
            name     = field.value.name
            type     = field.value.type
            required = false
          }
        }
      }
    }
  }

  tags = merge(local.common_tags, { Name = "agent-observability-${each.key}" })
}

resource "aws_s3tables_table" "agent_observability_protected" {
  for_each = var.agent_observability_history_enabled && var.deletion_protection_enabled ? local.observability_table_columns : {}

  name             = replace(each.key, "-", "_")
  namespace        = aws_s3tables_namespace.agent_observability[0].namespace
  table_bucket_arn = aws_s3tables_table_bucket.agent_observability[0].arn
  format           = "ICEBERG"

  maintenance_configuration = local.observability_table_maintenance

  metadata {
    iceberg {
      schema {
        dynamic "field" {
          for_each = each.value
          content {
            name     = field.value.name
            type     = field.value.type
            required = false
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.common_tags, { Name = "agent-observability-${each.key}" })
}
