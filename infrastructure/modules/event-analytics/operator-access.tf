# Operators query the semantic event log with their own credentials through the event analytics
# script or MCP server. The log spans every tenant, so attach this policy to operator principals only.
data "aws_iam_policy_document" "operator_query" {
  statement {
    sid = "RunEventQueries"
    actions = [
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:GetWorkGroup",
      "athena:StartQueryExecution",
      "athena:StopQueryExecution",
    ]
    resources = [aws_athena_workgroup.events.arn]
  }

  statement {
    sid = "ReadEventCatalog"
    actions = [
      "glue:GetCatalog",
      "glue:GetCatalogs",
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetTable",
      "glue:GetTables",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ReadEventTable"
    actions = [
      "s3tables:GetNamespace",
      "s3tables:GetTable",
      "s3tables:GetTableBucket",
      "s3tables:GetTableData",
      "s3tables:GetTableMetadataLocation",
      "s3tables:ListNamespaces",
      "s3tables:ListTables",
    ]
    resources = [var.s3_table_bucket_arn, var.s3_table_arn]
  }

  statement {
    sid = "WriteQueryResults"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = [aws_s3_bucket.athena_results.arn, "${aws_s3_bucket.athena_results.arn}/*"]
  }
}

resource "aws_iam_policy" "operator_query" {
  name        = "${local.name_prefix}-operator-query"
  description = "Read-only Athena access to the cross-tenant semantic event log for platform operators."
  policy      = data.aws_iam_policy_document.operator_query.json
  tags        = local.common_tags
}
