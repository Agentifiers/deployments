locals {
  s3tables_child_catalog_arn = "${var.s3tables_catalog_arn}/${var.s3_table_bucket_name}"
}

resource "aws_cloudwatch_log_group" "firehose" {
  for_each = var.s3_table_names

  name              = "/aws/kinesisfirehose/${local.name_prefix}/${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_stream" "firehose" {
  for_each = var.s3_table_names

  name           = "iceberg-delivery"
  log_group_name = aws_cloudwatch_log_group.firehose[each.key].name
}

data "aws_iam_policy_document" "firehose_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name                 = "${local.name_prefix}-firehose"
  assume_role_policy   = data.aws_iam_policy_document.firehose_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "firehose" {
  statement {
    actions = [
      "glue:GetCatalog",
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetTable",
      "glue:GetTables",
      "glue:GetTableVersion",
      "glue:GetTableVersions",
      "glue:UpdateTable",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "s3tables:GetNamespace",
      "s3tables:GetTableBucket",
      "s3tables:ListNamespaces",
      "s3tables:ListTables",
    ]
    resources = [var.s3_table_bucket_arn]
  }

  statement {
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
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.runtime["backup"].arn,
      "${aws_s3_bucket.runtime["backup"].arn}/*",
    ]
  }

  statement {
    actions   = ["logs:PutLogEvents"]
    resources = [for group in aws_cloudwatch_log_group.firehose : "${group.arn}:log-stream:*"]
  }
}

resource "aws_iam_role_policy" "firehose" {
  name   = "agent-observability-iceberg-delivery"
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose.json
}

resource "aws_kinesis_firehose_delivery_stream" "history" {
  for_each = var.s3_table_names

  name        = "${local.name_prefix}-${replace(each.key, "-", "")}"
  destination = "iceberg"
  tags        = local.common_tags

  iceberg_configuration {
    append_only        = true
    buffering_interval = 60
    buffering_size     = 5
    catalog_arn        = local.s3tables_child_catalog_arn
    retry_duration     = 300
    role_arn           = aws_iam_role.firehose.arn
    s3_backup_mode     = "FailedDataOnly"

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose[each.key].name
      log_stream_name = aws_cloudwatch_log_stream.firehose[each.key].name
    }

    destination_table_configuration {
      database_name = var.s3_table_namespace
      table_name    = each.value
    }

    s3_configuration {
      bucket_arn          = aws_s3_bucket.runtime["backup"].arn
      buffering_interval  = 60
      buffering_size      = 5
      compression_format  = "UNCOMPRESSED"
      error_output_prefix = "${each.key}/errors/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/!{firehose:error-output-type}/"
      prefix              = "${each.key}/backup/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"
      role_arn            = aws_iam_role.firehose.arn

      cloudwatch_logging_options {
        enabled         = true
        log_group_name  = aws_cloudwatch_log_group.firehose[each.key].name
        log_stream_name = aws_cloudwatch_log_stream.firehose[each.key].name
      }
    }
  }

  depends_on = [aws_iam_role_policy.firehose]
}
