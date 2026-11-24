locals {
  client_bootstrap_marker_name = "/identity/oauth-clients-bootstrapped"
  deployment_role_arn          = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.deploying_role_name}"
}

data "aws_iam_policy_document" "client_bootstrap_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [local.deployment_role_arn]
    }
  }
}

resource "aws_iam_role" "client_bootstrap" {
  name                 = "${local.name}-client-bootstrap"
  assume_role_policy   = data.aws_iam_policy_document.client_bootstrap_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "client_bootstrap" {
  statement {
    sid       = "WriteOAuthClientRecords"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"]
    resources = [var.identity_table_arn]
  }

  # The web, E2E, and operator-declared clients here, and the apps client the app-runtime module names.
  statement {
    sid       = "ManageClientSecretParameters"
    actions   = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = ["${local.parameter_arn_prefix}/${local.name}/*-oauth-client"]
  }

  statement {
    sid       = "WriteBootstrapMarker"
    actions   = ["ssm:PutParameter"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.client_bootstrap_marker_name}"]
  }
}

resource "aws_iam_role_policy" "client_bootstrap" {
  name   = "${local.name}-client-bootstrap"
  role   = aws_iam_role.client_bootstrap.id
  policy = data.aws_iam_policy_document.client_bootstrap.json
}

removed {
  from = aws_secretsmanager_secret_policy.web_client
  lifecycle { destroy = false }
}
