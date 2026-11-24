data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "database_function" {
  name              = "/aws/lambda/apps-database"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "database_function" {
  name                 = "apps-database"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "database_function" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.database_function.arn}:*"]
  }

  statement {
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

  statement {
    sid     = "ConnectAsProvisionerOwnerAndViewer"
    actions = ["rds-db:connect"]
    resources = [
      "${local.database_users}/platform_provisioner",
      "${local.database_users}/app_*_owner",
      "${local.database_users}/app_*_viewer",
    ]
  }

  statement {
    sid       = "WriteExports"
    actions   = ["s3:AbortMultipartUpload", "s3:PutObject"]
    resources = [local.export_objects]
  }

  statement {
    sid       = "ListAppObjects"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.apps.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["apps/*"]
    }
  }

  statement {
    sid       = "EraseAppObjects"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.apps.arn}/apps/*"]
  }

  statement {
    sid = "MapAppHosts"
    actions = [
      "cloudfront-keyvaluestore:DeleteKey",
      "cloudfront-keyvaluestore:DescribeKeyValueStore",
      "cloudfront-keyvaluestore:GetKey",
      "cloudfront-keyvaluestore:PutKey",
    ]
    resources = [aws_cloudfront_key_value_store.app_hosts.arn]
  }
}

resource "aws_iam_role_policy" "database_function" {
  name   = "apps-database"
  role   = aws_iam_role.database_function.id
  policy = data.aws_iam_policy_document.database_function.json
}

resource "aws_lambda_function" "database" {
  function_name     = "apps-database"
  description       = "Provisions, migrates, queries, describes, exports, and erases app databases."
  architectures     = ["arm64"]
  handler           = "index.handler"
  memory_size       = 1024
  role              = aws_iam_role.database_function.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.database_function_artifact.bucket
  s3_key            = var.database_function_artifact.key
  s3_object_version = var.database_function_artifact.version
  timeout           = 300

  environment {
    variables = {
      APPS_BUCKET              = aws_s3_bucket.apps.bucket
      APPS_DATABASE_HOST       = aws_rds_cluster.apps.endpoint
      APPS_DATABASE_PORT       = tostring(local.database_port)
      APPS_DATABASE_REGION     = data.aws_region.current.region
      APPS_KEY_VALUE_STORE_ARN = aws_cloudfront_key_value_store.app_hosts.arn
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.client["database-function"].id]
    subnet_ids         = var.private_subnet_ids
  }

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.database_function,
    aws_iam_role_policy.database_function,
  ]
}
