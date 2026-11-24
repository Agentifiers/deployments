locals {
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
    },
    var.tags,
  )
}

data "aws_iam_policy_document" "document_extraction_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "document_extraction" {
  name              = "/aws/lambda/document-extraction"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "document_extraction" {
  name                 = "agent-document-extraction"
  assume_role_policy   = data.aws_iam_policy_document.document_extraction_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "document_extraction" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.document_extraction.arn}:*"]
  }

  dynamic "statement" {
    for_each = var.network == null ? [] : [1]
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

  dynamic "statement" {
    for_each = var.ocr_enabled ? [1] : []
    content {
      sid       = "RecognizeScannedPages"
      actions   = ["textract:DetectDocumentText"]
      resources = ["*"] # Textract defines no resource types.
      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [data.aws_region.current.region]
      }
    }
  }
}

resource "aws_iam_role_policy" "document_extraction" {
  name   = "document-extraction"
  role   = aws_iam_role.document_extraction.id
  policy = data.aws_iam_policy_document.document_extraction.json
}

# DNS needs no rule: security groups cannot block queries to the VPC's Route 53 Resolver.
resource "aws_security_group" "document_extraction" {
  count = var.network == null ? 0 : 1

  name_prefix = "document-extraction-"
  # Keep the description unchanged: changing it replaces the group while Lambda network
  # interfaces still use it.
  description = "Document extraction: HTTPS to S3 through the gateway endpoint only"
  vpc_id      = var.network.vpc_id

  tags = merge(local.common_tags, { Name = "document-extraction" })
}

resource "aws_vpc_security_group_egress_rule" "document_extraction_s3" {
  count = var.network == null ? 0 : 1

  security_group_id = aws_security_group.document_extraction[0].id
  prefix_list_id    = var.network.s3_prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = local.common_tags
}

resource "aws_lambda_function" "document_extraction" {
  function_name     = "document-extraction"
  description       = "Extracts bounded text from untrusted document bytes in a per-file sandboxed Node child."
  architectures     = ["arm64"]
  handler           = "handler.handler"
  memory_size       = 2048
  role              = aws_iam_role.document_extraction.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 120

  dynamic "vpc_config" {
    for_each = var.network == null ? [] : [var.network]
    content {
      security_group_ids = [aws_security_group.document_extraction[0].id]
      subnet_ids         = vpc_config.value.private_subnet_ids
    }
  }

  dynamic "environment" {
    for_each = local.textract_endpoint_url == null ? [] : [local.textract_endpoint_url]
    content {
      variables = { DEPLOYMENTS_AI_TEXTRACT_ENDPOINT = environment.value }
    }
  }

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  tags = local.common_tags

  # Inside the VPC the function's Textract host resolves to the endpoint only once the endpoint's
  # private DNS exists.
  depends_on = [
    aws_cloudwatch_log_group.document_extraction,
    aws_iam_role_policy.document_extraction,
    aws_vpc_endpoint.textract,
  ]
}
