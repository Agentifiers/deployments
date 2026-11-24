data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix = "sandbox"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "sandbox"
    },
    var.tags,
  )

  microvm_artifact_bucket_name = "microvm-artifacts-${data.aws_caller_identity.current.account_id}"
  # An install may pass its own role; otherwise MicroVMs run as the module's log-only role.
  create_microvm_execution_role = var.lambda_microvm_enabled && trimspace(var.lambda_microvm_execution_role_arn) == ""
  lambda_microvm_execution_role_arn = (
    trimspace(var.lambda_microvm_execution_role_arn) != ""
    ? trimspace(var.lambda_microvm_execution_role_arn)
    : try(aws_iam_role.microvm_execution[0].arn, "")
  )
  lambda_microvm_image_resource_arn = trimspace(var.lambda_microvm_image_identifier) != "" ? trimspace(var.lambda_microvm_image_identifier) : "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:microvm-image:*"
  lambda_microvm_resource_arn       = "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:microvm:*"
}

resource "aws_s3_bucket" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  bucket        = local.microvm_artifact_bucket_name
  force_destroy = true
  tags          = merge(local.common_tags, { Component = "lambda-microvm-image-build" })
}

resource "aws_s3_bucket_public_access_block" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  bucket = aws_s3_bucket.microvm_artifacts[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  bucket = aws_s3_bucket.microvm_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  bucket = aws_s3_bucket.microvm_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  bucket = aws_s3_bucket.microvm_artifacts[0].id

  rule {
    id     = "expire-build-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

data "aws_iam_policy_document" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.microvm_artifacts[0].arn,
      "${aws_s3_bucket.microvm_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "microvm_artifacts" {
  count = var.lambda_microvm_enabled ? 1 : 0

  bucket = aws_s3_bucket.microvm_artifacts[0].id
  policy = data.aws_iam_policy_document.microvm_artifacts[0].json
}

resource "aws_cloudwatch_log_group" "microvm" {
  count = var.lambda_microvm_enabled ? 1 : 0

  name              = "/aws/lambda-microvms/deployments-ai-sandbox"
  retention_in_days = var.log_retention_in_days
  tags              = merge(local.common_tags, { Component = "lambda-microvm" })
}

data "aws_iam_policy_document" "microvm_build_assume_role" {
  count = var.lambda_microvm_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "microvm_build" {
  count = var.lambda_microvm_enabled ? 1 : 0

  name                 = "microvm-build"
  description          = "Builds content-addressed Lambda MicroVM sandbox images"
  assume_role_policy   = data.aws_iam_policy_document.microvm_build_assume_role[0].json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "microvm_build" {
  count = var.lambda_microvm_enabled ? 1 : 0

  statement {
    sid       = "ReadBuildArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.microvm_artifacts[0].arn}/*"]
  }

  statement {
    sid       = "WriteMicrovmLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.microvm[0].arn}:*"]
  }

  statement {
    sid = "ReadPublicBaseImages"
    actions = [
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "microvm_build" {
  count = var.lambda_microvm_enabled ? 1 : 0

  name   = "MicrovmBuildPolicy"
  role   = aws_iam_role.microvm_build[0].id
  policy = data.aws_iam_policy_document.microvm_build[0].json
}

# Lambda forwards a running MicroVM's stdout and stderr to CloudWatch only under an execution role.
# This role can write to the sandbox log group and nothing else, so guest code that reads its
# credentials from the MicroVM metadata service gains no other AWS access.
data "aws_iam_policy_document" "microvm_execution_assume_role" {
  count = local.create_microvm_execution_role ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    # Lambda assumes the role on behalf of the MicroVM image, not the MicroVM.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:microvm-image:*"]
    }
  }
}

resource "aws_iam_role" "microvm_execution" {
  count = local.create_microvm_execution_role ? 1 : 0

  name                 = "microvm-execution"
  description          = "Writes Lambda MicroVM sandbox runtime logs"
  assume_role_policy   = data.aws_iam_policy_document.microvm_execution_assume_role[0].json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "microvm_execution" {
  count = local.create_microvm_execution_role ? 1 : 0

  statement {
    sid       = "WriteMicrovmRuntimeLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.microvm[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "microvm_execution" {
  count = local.create_microvm_execution_role ? 1 : 0

  name   = "MicrovmRuntimeLogs"
  role   = aws_iam_role.microvm_execution[0].id
  policy = data.aws_iam_policy_document.microvm_execution[0].json
}

data "aws_iam_policy_document" "lambda_microvm_runtime" {
  count = var.lambda_microvm_enabled ? 1 : 0

  statement {
    sid       = "RunSandboxMicrovms"
    actions   = ["lambda:RunMicrovm"]
    resources = [local.lambda_microvm_image_resource_arn, local.lambda_microvm_resource_arn]
  }

  # The IAM action table scopes runtime calls to the image while the Lambda
  # operator example uses MicroVM instance ARNs. Include both scoped forms.
  statement {
    sid = "ManageSandboxMicrovms"
    actions = [
      "lambda:CreateMicrovmAuthToken",
      "lambda:GetMicrovm",
      "lambda:ResumeMicrovm",
      "lambda:SuspendMicrovm",
      "lambda:TerminateMicrovm",
    ]
    resources = [local.lambda_microvm_image_resource_arn, local.lambda_microvm_resource_arn]
  }

  statement {
    sid       = "PassSandboxMicrovmExecutionRole"
    actions   = ["iam:PassRole"]
    resources = [local.lambda_microvm_execution_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "lambda.amazonaws.com",
        "lambda-microvms.amazonaws.com",
      ]
    }
  }

  # PassNetworkConnector does not support resource-level permissions.
  statement {
    sid       = "PassSandboxNetworkConnectors"
    actions   = ["lambda:PassNetworkConnector"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "lambda_microvm_runtime" {
  count = var.lambda_microvm_enabled ? 1 : 0

  name        = "${local.name_prefix}-lambda-microvm-runtime"
  description = "Allows a platform worker to manage Lambda MicroVM sandboxes."
  policy      = data.aws_iam_policy_document.lambda_microvm_runtime[0].json
  tags        = local.common_tags
}
