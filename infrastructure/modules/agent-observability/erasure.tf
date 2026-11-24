locals {
  erasure_function_name = "${local.name_prefix}-erasure"
  erasure_results_path  = "erasure-results/"
  erasure_vpc_enabled   = var.network != null
  erasure_hot_plane = trimspace(var.hot_plane_base_url) == "" ? {} : {
    DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL   = var.hot_plane_base_url
    DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN = var.hot_plane_secret_arn
  }
  s3tables_glue_prefix = "arn:aws:glue:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}"
}

# Tenant-erasure DELETE statements run in a dedicated workgroup whose results prefix
# only the erasure role reads. Athena rejects DML against S3 Tables in SSE_KMS
# workgroups, so it must stay SSE_S3. Results hold only row counts and statement
# metadata, never tenant rows.
resource "aws_athena_workgroup" "erasure" {
  name          = "${local.name_prefix}-erasure"
  description   = "Tenant-erasure count and DELETE statements over agent observability Iceberg history."
  force_destroy = !var.deletion_protection_enabled || var.destructive_cleanup_enabled
  tags          = local.common_tags

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    engine_version {
      selected_engine_version = "Athena engine version 3"
    }

    result_configuration {
      output_location = "s3://${aws_s3_bucket.runtime["athena"].id}/${local.erasure_results_path}"
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

resource "aws_security_group" "erasure" {
  count = local.erasure_vpc_enabled ? 1 : 0

  name_prefix = "${local.erasure_function_name}-"
  description = "Observability erasure Lambda egress to the private hot plane and AWS APIs"
  vpc_id      = var.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "erasure" {
  name              = "/aws/lambda/${local.erasure_function_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "erasure" {
  name                 = local.erasure_function_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "erasure" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.erasure.arn}:*"]
  }

  statement {
    sid       = "ReadErasureFence"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table_arn]
  }

  statement {
    sid       = "ReadPipelineLag"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]
  }

  statement {
    sid = "RunErasureQueries"
    actions = [
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:GetWorkGroup",
      "athena:StartQueryExecution",
      "athena:StopQueryExecution",
    ]
    resources = [aws_athena_workgroup.erasure.arn]
  }

  statement {
    sid = "ResolveIcebergCatalog"
    actions = [
      "glue:GetCatalog",
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetTable",
      "glue:GetTables",
      "glue:UpdateTable",
    ]
    resources = [
      "${local.s3tables_glue_prefix}:catalog",
      var.s3tables_catalog_arn,
      local.s3tables_child_catalog_arn,
      "${local.s3tables_glue_prefix}:database/${var.s3tables_catalog_name}/${var.s3_table_bucket_name}/${var.s3_table_namespace}",
      "${local.s3tables_glue_prefix}:table/${var.s3tables_catalog_name}/${var.s3_table_bucket_name}/${var.s3_table_namespace}/*",
    ]
  }

  statement {
    sid = "ReadObservabilityTableBucket"
    actions = [
      "s3tables:GetNamespace",
      "s3tables:GetTableBucket",
      "s3tables:ListNamespaces",
      "s3tables:ListTables",
    ]
    resources = [var.s3_table_bucket_arn]
  }

  statement {
    sid = "RewriteObservabilityTables"
    actions = [
      "s3tables:GetTable",
      "s3tables:GetTableData",
      "s3tables:GetTableMetadataLocation",
      "s3tables:PutTableData",
      "s3tables:UpdateTableMetadataLocation",
    ]
    resources = values(var.s3_table_arns)
  }

  statement {
    sid       = "ErasureResultsBucket"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.runtime["athena"].arn]
  }

  statement {
    sid = "ErasureResults"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.runtime["athena"].arn}/${local.erasure_results_path}*"]
  }

  dynamic "statement" {
    for_each = trimspace(var.hot_plane_secret_arn) == "" ? [] : [1]
    content {
      sid       = "ReadHotPlaneServiceCredential"
      actions   = ["ssm:GetParameter"]
      resources = [var.hot_plane_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = local.erasure_vpc_enabled ? [1] : []
    content {
      sid = "VpcNetworking"
      actions = [
        "ec2:AssignPrivateIpAddresses",
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:UnassignPrivateIpAddresses",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "erasure" {
  name   = "agent-observability-erasure"
  role   = aws_iam_role.erasure.id
  policy = data.aws_iam_policy_document.erasure.json
}

resource "aws_lambda_function" "erasure" {
  function_name = local.erasure_function_name
  description   = "Purges an erased organization's observability data from ClickHouse and Iceberg history."
  architectures = ["arm64"]
  handler       = "observability-erasure-main.handler"
  memory_size   = 512
  role          = aws_iam_role.erasure.arn
  runtime       = "nodejs26.x"
  timeout       = 900

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = (trimspace(var.hot_plane_base_url) == "") == (trimspace(var.hot_plane_secret_arn) == "")
      error_message = "hot_plane_base_url and hot_plane_secret_arn must be configured together."
    }
    precondition {
      condition     = trimspace(var.hot_plane_base_url) == "" || local.erasure_vpc_enabled
      error_message = "The erasure Lambda must be VPC-attached to reach the private hot plane."
    }
    precondition {
      condition     = !local.erasure_vpc_enabled || length(try(var.network.private_subnet_ids, [])) > 0
      error_message = "network.private_subnet_ids must not be empty."
    }
  }

  dynamic "vpc_config" {
    for_each = local.erasure_vpc_enabled ? [var.network] : []
    content {
      security_group_ids = [aws_security_group.erasure[0].id]
      subnet_ids         = vpc_config.value.private_subnet_ids
    }
  }

  environment {
    variables = merge({
      DEPLOYMENTS_AI_CONTROL_TABLE                          = var.control_table_name
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ATHENA_WORKGROUP = aws_athena_workgroup.erasure.name
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_TABLES = jsonencode({
        for name, table_name in var.s3_table_names : table_name => local.table_refs[name]
      })
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_PIPELINE_FUNCTIONS = jsonencode(values(local.lambda_functions))
      DEPLOYMENTS_AI_OBSERVABILITY_FIREHOSE_STREAMS = jsonencode({
        for name, stream in aws_kinesis_firehose_delivery_stream.history : name => stream.name
      })
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_SNAPSHOT_MAX_AGE_HOURS = var.physical_removal.snapshot_max_age_hours
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_UNREFERENCED_FILE_DAYS = var.physical_removal.unreferenced_file_days
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_NONCURRENT_FILE_DAYS   = var.physical_removal.noncurrent_file_days
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_CLICKHOUSE_NATIVE_BACKUP_DAYS  = var.clickhouse_backup_expiry_days.native_backup
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_CLICKHOUSE_SNAPSHOT_DAYS       = var.clickhouse_backup_expiry_days.ebs_snapshot
    }, local.erasure_hot_plane)
  }

  depends_on = [aws_cloudwatch_log_group.erasure, aws_iam_role_policy.erasure]
  tags       = local.common_tags
}
