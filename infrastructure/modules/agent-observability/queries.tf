locals {
  query_context_database_name = "agent_observability_context"
  table_refs = {
    for name, table_name in var.s3_table_names :
    name => "\"${var.s3tables_catalog_name}/${var.s3_table_bucket_name}\".\"${var.s3_table_namespace}\".\"${table_name}\""
  }
}

resource "aws_glue_catalog_database" "query_context" {
  name        = local.query_context_database_name
  description = "Root catalog context for fully qualified agent observability cold-history queries."
  tags        = local.common_tags
}

resource "aws_athena_workgroup" "observability" {
  name          = "${local.name_prefix}-cold-history"
  description   = "Bounded reconciliation, rebuild, and export queries over agent observability Iceberg history."
  force_destroy = !var.deletion_protection_enabled || var.destructive_cleanup_enabled
  tags          = local.common_tags

  configuration {
    bytes_scanned_cutoff_per_query     = var.athena_bytes_scanned_cutoff
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.runtime["athena"].id}/results/"
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

resource "aws_athena_named_query" "source_watermarks" {
  name        = "agent_observability_source_watermarks"
  description = "Latest committed normalized-stream sequence by Kinesis shard and cold-history table."
  database    = aws_glue_catalog_database.query_context.name
  workgroup   = aws_athena_workgroup.observability.name
  query       = <<-SQL
    SELECT fact_family, projection_stream_arn, projection_shard_id,
           max_by(
             projection_sequence_number,
             ROW(length(projection_sequence_number), projection_sequence_number)
           ) AS projection_sequence_watermark,
           max(from_iso8601_timestamp(projected_at)) AS projected_watermark
    FROM (
      SELECT 'spans' AS fact_family, projection_stream_arn, projection_shard_id, projection_sequence_number, projected_at FROM ${local.table_refs["spans"]} WHERE fact_type != 'projection.checkpoint'
      UNION ALL
      SELECT 'traces', projection_stream_arn, projection_shard_id, projection_sequence_number, projected_at FROM ${local.table_refs["traces"]} WHERE fact_type != 'projection.checkpoint'
      UNION ALL
      SELECT 'model-invocations', projection_stream_arn, projection_shard_id, projection_sequence_number, projected_at FROM ${local.table_refs["model-invocations"]} WHERE fact_type != 'projection.checkpoint'
      UNION ALL
      SELECT 'usage', projection_stream_arn, projection_shard_id, projection_sequence_number, projected_at FROM ${local.table_refs["usage"]} WHERE fact_type != 'projection.checkpoint'
      UNION ALL
      SELECT 'tombstones', projection_stream_arn, projection_shard_id, projection_sequence_number, projected_at FROM ${local.table_refs["tombstones"]} WHERE fact_type != 'projection.checkpoint'
    ) facts
    WHERE projection_stream_arn IS NOT NULL
      AND projection_shard_id IS NOT NULL
      AND projection_sequence_number IS NOT NULL
    GROUP BY fact_family, projection_stream_arn, projection_shard_id
    ORDER BY fact_family, projection_stream_arn, projection_shard_id;
  SQL
}

resource "aws_athena_named_query" "trace_reconciliation" {
  name        = "agent_observability_trace_usage_reconciliation"
  description = "Compare latest finalized trace totals with deduplicated usage facts."
  database    = aws_glue_catalog_database.query_context.name
  workgroup   = aws_athena_workgroup.observability.name
  query       = <<-SQL
    WITH tombstone_deliveries AS (
      SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY fact_id ORDER BY projected_at DESC) AS delivery_rank
        FROM ${local.table_refs["tombstones"]}
        WHERE fact_type != 'projection.checkpoint'
      ) WHERE delivery_rank = 1
    ), tombstone_rules AS (
      SELECT organization_id, project_id, environment_id,
             source_table, source_record_type, source_record_id,
             delete_through_record_version, deleted_fact_types_json
      FROM tombstone_deliveries
    ), trace_deliveries AS (
      SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY fact_id ORDER BY projected_at DESC) AS delivery_rank
        FROM ${local.table_refs["traces"]}
        WHERE fact_type != 'projection.checkpoint'
      ) WHERE delivery_rank = 1
    ), active_traces AS (
      SELECT traces.*
      FROM trace_deliveries traces
      WHERE NOT EXISTS (
        SELECT 1 FROM tombstone_rules tombstones
        WHERE tombstones.organization_id = traces.organization_id
          AND tombstones.project_id = traces.project_id
          AND tombstones.environment_id = traces.environment_id
          AND tombstones.source_table = traces.source_table
          AND tombstones.source_record_type = traces.source_record_type
          AND tombstones.source_record_id = traces.source_record_id
          AND traces.source_record_version <= tombstones.delete_through_record_version
          AND contains(
            CAST(json_parse(tombstones.deleted_fact_types_json) AS array(varchar)),
            traces.fact_type
          )
      )
    ), latest_traces AS (
      SELECT * FROM (
        SELECT *, row_number() OVER (
          PARTITION BY organization_id, project_id, environment_id,
                       source_table, source_record_type, source_record_id, fact_type
          ORDER BY source_record_version DESC, projected_at DESC
        ) AS logical_rank
        FROM active_traces
      ) WHERE logical_rank = 1
    ), usage_deliveries AS (
      SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY fact_id ORDER BY projected_at DESC) AS delivery_rank
        FROM ${local.table_refs["usage"]}
        WHERE fact_type != 'projection.checkpoint'
      ) WHERE delivery_rank = 1
    ), active_usage AS (
      SELECT usage.*
      FROM usage_deliveries usage
      WHERE NOT EXISTS (
        SELECT 1 FROM tombstone_rules tombstones
        WHERE tombstones.organization_id = usage.organization_id
          AND tombstones.project_id = usage.project_id
          AND tombstones.environment_id = usage.environment_id
          AND tombstones.source_table = usage.source_table
          AND tombstones.source_record_type = usage.source_record_type
          AND tombstones.source_record_id = usage.source_record_id
          AND usage.source_record_version <= tombstones.delete_through_record_version
          AND contains(
            CAST(json_parse(tombstones.deleted_fact_types_json) AS array(varchar)),
            usage.fact_type
          )
      )
    ), latest_usage AS (
      SELECT * FROM (
        SELECT *, row_number() OVER (
          PARTITION BY organization_id, project_id, environment_id,
                       source_table, source_record_type, source_record_id, fact_type
          ORDER BY source_record_version DESC, projected_at DESC
        ) AS logical_rank
        FROM active_usage
      ) WHERE logical_rank = 1
    ), usage_totals AS (
      SELECT usage.organization_id, usage.project_id, usage.environment_id, usage.trace_id,
             CAST(least(
               sum(CAST(usage.quantity AS decimal(38, 0))),
               CAST(9007199254740991 AS decimal(38, 0))
             ) AS bigint) AS projected_tokens,
             CAST(least(
               sum(CAST(coalesce(usage.cost_usd_micros, 0) AS decimal(38, 0))),
               CAST(9007199254740991 AS decimal(38, 0))
             ) AS bigint) AS projected_cost_usd_micros
      FROM latest_usage usage
      WHERE usage.metric = 'model_tokens'
        AND usage.unit = 'tokens'
      GROUP BY usage.organization_id, usage.project_id, usage.environment_id, usage.trace_id
    )
    SELECT traces.organization_id, traces.project_id, traces.environment_id, traces.trace_id,
           traces.total_tokens AS canonical_tokens,
           coalesce(usage.projected_tokens, 0) AS projected_tokens,
           traces.total_cost_usd_micros AS canonical_cost_usd_micros,
           coalesce(usage.projected_cost_usd_micros, 0) AS projected_cost_usd_micros,
           traces.total_tokens = coalesce(usage.projected_tokens, 0)
             AND traces.total_cost_usd_micros = coalesce(usage.projected_cost_usd_micros, 0) AS reconciled
    FROM latest_traces traces
    LEFT JOIN usage_totals usage
      ON usage.organization_id = traces.organization_id
      AND usage.project_id = traces.project_id
      AND usage.environment_id = traces.environment_id
      AND usage.trace_id = traces.trace_id
    ORDER BY reconciled ASC, traces.finalized_at DESC;
  SQL
}

resource "aws_athena_named_query" "rebuild_export" {
  name        = "agent_observability_rebuild_export"
  description = "Deduplicated fact export with deletion tombstones retained for rebuild consumers."
  database    = aws_glue_catalog_database.query_context.name
  workgroup   = aws_athena_workgroup.observability.name
  query       = <<-SQL
    WITH all_facts AS (
      SELECT 'spans' AS fact_family, fact_id, fact_type, schema_version,
             redaction_policy_version, capture_mode,
             organization_id, project_id, environment_id, workspace_id,
             trace_id, span_id, parent_span_id, run_id, session_id,
             source_table, source_record_type, source_record_id, source_record_version,
             source_stream_arn, source_stream_sequence_number,
             occurred_at, normalized_at, projected_at,
             projection_stream_arn, projection_shard_id, projection_sequence_number,
             payload_json,
             CAST(NULL AS bigint) AS delete_through_record_version,
             CAST(NULL AS varchar) AS deleted_fact_types_json
      FROM ${local.table_refs["spans"]}
      WHERE fact_type != 'projection.checkpoint'
      -- SPANS_RETENTION_FILTER
      UNION ALL
      SELECT 'traces', fact_id, fact_type, schema_version,
             redaction_policy_version, capture_mode,
             organization_id, project_id, environment_id, workspace_id,
             trace_id, span_id, parent_span_id, run_id, session_id,
             source_table, source_record_type, source_record_id, source_record_version,
             source_stream_arn, source_stream_sequence_number,
             occurred_at, normalized_at, projected_at,
             projection_stream_arn, projection_shard_id, projection_sequence_number,
             payload_json,
             CAST(NULL AS bigint), CAST(NULL AS varchar)
      FROM ${local.table_refs["traces"]}
      WHERE fact_type != 'projection.checkpoint'
      -- TRACES_RETENTION_FILTER
      UNION ALL
      SELECT 'model-invocations', fact_id, fact_type, schema_version,
             redaction_policy_version, capture_mode,
             organization_id, project_id, environment_id, workspace_id,
             trace_id, span_id, parent_span_id, run_id, session_id,
             source_table, source_record_type, source_record_id, source_record_version,
             source_stream_arn, source_stream_sequence_number,
             occurred_at, normalized_at, projected_at,
             projection_stream_arn, projection_shard_id, projection_sequence_number,
             payload_json,
             CAST(NULL AS bigint), CAST(NULL AS varchar)
      FROM ${local.table_refs["model-invocations"]}
      WHERE fact_type != 'projection.checkpoint'
      -- MODEL_INVOCATIONS_RETENTION_FILTER
      UNION ALL
      SELECT 'usage', fact_id, fact_type, schema_version,
             redaction_policy_version, capture_mode,
             organization_id, project_id, environment_id, workspace_id,
             trace_id, span_id, parent_span_id, run_id, session_id,
             source_table, source_record_type, source_record_id, source_record_version,
             source_stream_arn, source_stream_sequence_number,
             occurred_at, normalized_at, projected_at,
             projection_stream_arn, projection_shard_id, projection_sequence_number,
             payload_json,
             CAST(NULL AS bigint), CAST(NULL AS varchar)
      FROM ${local.table_refs["usage"]}
      WHERE fact_type != 'projection.checkpoint'
      -- USAGE_RETENTION_FILTER
      UNION ALL
      SELECT 'tombstones', fact_id, fact_type, schema_version,
             redaction_policy_version, capture_mode,
             organization_id, project_id, environment_id, workspace_id,
             trace_id, span_id, parent_span_id, run_id, session_id,
             source_table, source_record_type, source_record_id, source_record_version,
             source_stream_arn, source_stream_sequence_number,
             occurred_at, normalized_at, projected_at,
             projection_stream_arn, projection_shard_id, projection_sequence_number,
             payload_json,
             delete_through_record_version, deleted_fact_types_json
      FROM ${local.table_refs["tombstones"]}
      WHERE fact_type != 'projection.checkpoint'
      -- TOMBSTONES_RETENTION_FILTER
    ), delivery_ranked AS (
      SELECT *, row_number() OVER (PARTITION BY fact_id ORDER BY projected_at DESC) AS delivery_rank
      FROM all_facts
    ), logical_ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY organization_id, project_id, environment_id,
                     source_table, source_record_type, source_record_id, fact_type
        ORDER BY source_record_version DESC, projected_at DESC
      ) AS logical_rank
      FROM delivery_ranked
      WHERE delivery_rank = 1
    ), tombstone_rules AS (
      SELECT organization_id, project_id, environment_id,
             source_table, source_record_type, source_record_id,
             delete_through_record_version, deleted_fact_types_json
      FROM logical_ranked
      WHERE logical_rank = 1 AND fact_type = 'record.deleted'
    )
    SELECT fact_family, fact_id, fact_type, schema_version,
           redaction_policy_version, capture_mode,
           organization_id, project_id, environment_id, workspace_id,
           trace_id, span_id, parent_span_id, run_id, session_id,
           source_table, source_record_type, source_record_id, source_record_version,
           source_stream_arn, source_stream_sequence_number,
           occurred_at, normalized_at, projected_at,
           projection_stream_arn, projection_shard_id, projection_sequence_number,
           payload_json, delete_through_record_version, deleted_fact_types_json
    FROM logical_ranked facts
    WHERE logical_rank = 1
      AND (
        fact_type = 'record.deleted'
        OR NOT EXISTS (
          SELECT 1 FROM tombstone_rules tombstones
          WHERE tombstones.organization_id = facts.organization_id
            AND tombstones.project_id = facts.project_id
            AND tombstones.environment_id = facts.environment_id
            AND tombstones.source_table = facts.source_table
            AND tombstones.source_record_type = facts.source_record_type
            AND tombstones.source_record_id = facts.source_record_id
            AND facts.source_record_version <= tombstones.delete_through_record_version
            AND contains(
              CAST(json_parse(tombstones.deleted_fact_types_json) AS array(varchar)),
              facts.fact_type
            )
        )
      )
    ORDER BY normalized_at, fact_id;
  SQL
}

resource "aws_athena_named_query" "clickhouse_rebuild_export" {
  name        = "agent_observability_clickhouse_rebuild_export"
  description = "Retention-bounded deduplicated export for disposable ClickHouse reconstruction."
  database    = aws_glue_catalog_database.query_context.name
  workgroup   = aws_athena_workgroup.observability.name
  query = replace(replace(replace(replace(replace(
    aws_athena_named_query.rebuild_export.query,
    "-- SPANS_RETENTION_FILTER",
    "AND (from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '30' day OR (json_extract_scalar(payload_json, '$.kind') = 'run' AND from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '90' day))",
    ),
    "-- TRACES_RETENTION_FILTER",
    "AND from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '90' day",
    ),
    "-- MODEL_INVOCATIONS_RETENTION_FILTER",
    "AND from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '30' day",
    ),
    "-- USAGE_RETENTION_FILTER",
    "AND from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '30' day",
    ),
    "-- TOMBSTONES_RETENTION_FILTER",
    "AND from_iso8601_timestamp(occurred_at) >= current_timestamp - interval '90' day",
  )
}
