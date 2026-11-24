provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Environment = var.environment_name
      ManagedBy   = "terraform"
      Stack       = "customer-bootstrap"
    }
  }
}

data "aws_partition" "current" {}

locals {
  account_arn_prefix = "arn:${data.aws_partition.current.partition}:iam::${var.aws_account_id}"
  # The names the platform stack gives IAM roles, policies, and instance profiles (see infrastructure/bootstrap/dev).
  workload_name_prefixes             = ["agent-", "api-", "apps-", "brain-", "channel-", "console-", "credential-", "deployments-ai-platform-${var.environment_name}-", "durable-", "e2e-", "email-", "event-", "events-", "governance-", "identity-", "memory-", "microvm-", "models-", "oauth-", "ops-alerts-", "platform-${var.environment_name}-", "provider-", "sandbox-", "semantic-", "web-tools-"]
  workload_role_names                = ["api", "console"]
  workload_role_arns                 = concat([for prefix in local.workload_name_prefixes : "${local.account_arn_prefix}:role/${prefix}*"], [for name in local.workload_role_names : "${local.account_arn_prefix}:role/${name}"])
  workload_policy_arns               = [for prefix in local.workload_name_prefixes : "${local.account_arn_prefix}:policy/${prefix}*"]
  workload_instance_profile_arns     = [for prefix in local.workload_name_prefixes : "${local.account_arn_prefix}:instance-profile/${prefix}*"]
  workload_boundary_arn              = "${local.account_arn_prefix}:policy/${var.permissions_boundary_name}"
  bootstrap_role_arns                = ["${local.account_arn_prefix}:role/${var.deploy_role_name}", "${local.account_arn_prefix}:role/${var.observer_role_name}"]
  opensearch_service_linked_role_arn = "${local.account_arn_prefix}:role/aws-service-role/opensearchservice.amazonaws.com/AWSServiceRoleForAmazonOpenSearchService"
  observer_route_arn                 = "arn:${data.aws_partition.current.partition}:execute-api:${var.aws_region}:${var.aws_account_id}:*/*/GET/v1/system/observer/*"
  passed_to_services                 = ["ec2.amazonaws.com", "ecs-tasks.amazonaws.com", "events.amazonaws.com", "firehose.amazonaws.com", "lambda.amazonaws.com", "scheduler.amazonaws.com"]
  client_secret_parameter_arns       = ["arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter/", "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter/identity", "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter/identity/web-oauth-client", "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter/identity/apps-*-oauth-client"]
  external_id_condition              = { for key, value in { Condition = { StringEquals = { "sts:ExternalId" = var.external_id } } } : key => value if var.external_id != null }
  boundary_keyed_role_actions = [
    "iam:AttachRolePolicy",
    "iam:CreateRole",
    "iam:DeleteRole",
    "iam:DeleteRolePolicy",
    "iam:DetachRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:PutRolePolicy",
    "iam:UpdateAssumeRolePolicy",
    "iam:UpdateRole",
    "iam:UpdateRoleDescription",
  ]
  policy_write_actions = [
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:DeletePolicy",
    "iam:DeletePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "iam:TagPolicy",
    "iam:UntagPolicy",
  ]
}

resource "aws_s3_bucket" "state" {
  bucket = "platform-terraform-state-${var.aws_account_id}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_iam_role" "deploy" {
  name                 = var.deploy_role_name
  description          = "Deploys the platform into this account"
  max_session_duration = 43200

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [merge({
      Sid       = "DeployPrincipal"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = var.deploy_principal_arn }
    }, local.external_id_condition)]
  })
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each   = var.deploy_managed_policy_names
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/${each.value}"
}

resource "aws_iam_role_policy" "workload_iam" {
  name = "ManageWorkloadIam"
  role = aws_iam_role.deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadIamMetadata"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*"]
        Resource = "*"
      },
      {
        Sid      = "ManageOpenSearchServiceLinkedRole"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole", "iam:DeleteServiceLinkedRole", "iam:TagRole", "iam:UntagRole"]
        Resource = local.opensearch_service_linked_role_arn
      },
      {
        Sid       = "ManagePlatformRolesWithinBoundary"
        Effect    = "Allow"
        Action    = local.boundary_keyed_role_actions
        Resource  = local.workload_role_arns
        Condition = { StringEquals = { "iam:PermissionsBoundary" = local.workload_boundary_arn } }
      },
      {
        Sid      = "ManagePlatformPolicies"
        Effect   = "Allow"
        Action   = local.policy_write_actions
        Resource = local.workload_policy_arns
      },
      {
        Sid      = "TagPlatformRoles"
        Effect   = "Allow"
        Action   = ["iam:TagRole", "iam:UntagRole"]
        Resource = local.workload_role_arns
      },
      {
        Sid    = "ManagePlatformInstanceProfiles"
        Effect = "Allow"
        Action = [
          "iam:AddRoleToInstanceProfile",
          "iam:CreateInstanceProfile",
          "iam:DeleteInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile",
          "iam:TagInstanceProfile",
          "iam:UntagInstanceProfile",
        ]
        Resource = local.workload_instance_profile_arns
      },
      {
        Sid       = "PassPlatformWorkloadRoles"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = local.workload_role_arns
        Condition = { StringEquals = { "iam:PassedToService" = local.passed_to_services } }
      },
      {
        Sid       = "RequireWorkloadBoundary"
        Effect    = "Deny"
        Action    = local.boundary_keyed_role_actions
        Resource  = "*"
        Condition = { StringNotEquals = { "iam:PermissionsBoundary" = local.workload_boundary_arn } }
      },
      {
        Sid      = "KeepWorkloadBoundary"
        Effect   = "Deny"
        Action   = "iam:DeleteRolePermissionsBoundary"
        Resource = "*"
      },
      {
        Sid      = "ProtectWorkloadBoundary"
        Effect   = "Deny"
        Action   = local.policy_write_actions
        Resource = local.workload_boundary_arn
      },
      {
        Sid      = "ProtectBootstrapRoles"
        Effect   = "Deny"
        Action   = concat(local.boundary_keyed_role_actions, ["iam:PassRole", "iam:TagRole", "iam:UntagRole"])
        Resource = local.bootstrap_role_arns
      },
    ]
  })
}

# Parameter Store has no resource policies, so the deploy role itself is denied the sign-in
# client secrets that its managed policy would otherwise let it read. Path reads authorize on
# the path alone, so the root and /identity paths are denied too. The E2E client stays
# readable, because the E2E workflow signs in with it under this role.
resource "aws_iam_policy" "deny_client_secret_reads" {
  name        = "${var.deploy_role_name}-deny-client-secret-reads"
  description = "Denies the deploy role reads of the identity web and apps OAuth client secrets"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DenyClientSecretReads"
      Effect   = "Deny"
      Action   = "ssm:GetParameter*"
      Resource = local.client_secret_parameter_arns
    }]
  })
}

resource "aws_iam_role_policy_attachment" "deny_client_secret_reads" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deny_client_secret_reads.arn
}

resource "aws_iam_policy" "workload_boundary" {
  name        = var.permissions_boundary_name
  description = "Permissions boundary on every role the platform creates in this account"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowWorkloadServices"
        Effect    = "Allow"
        NotAction = ["account:*", "iam:*", "organizations:*"]
        Resource  = "*"
      },
      {
        Sid       = "PassPlatformRoles"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = local.workload_role_arns
        Condition = { StringEquals = { "iam:PassedToService" = local.passed_to_services } }
      },
      {
        Sid       = "CreateSesServiceLinkedRole"
        Effect    = "Allow"
        Action    = "iam:CreateServiceLinkedRole"
        Resource  = "${local.account_arn_prefix}:role/aws-service-role/ses.amazonaws.com/*"
        Condition = { StringEquals = { "iam:AWSServiceName" = "ses.amazonaws.com" } }
      },
      {
        Sid         = "DenyAssumingOtherRolesInThisAccount"
        Effect      = "Deny"
        Action      = "sts:AssumeRole"
        NotResource = local.workload_role_arns
        Condition   = { StringEquals = { "aws:ResourceAccount" = var.aws_account_id } }
      },
      {
        Sid      = "ProtectBootstrap"
        Effect   = "Deny"
        Action   = ["iam:*", "sts:AssumeRole"]
        Resource = concat(local.bootstrap_role_arns, [local.workload_boundary_arn])
      },
    ]
  })
}

resource "aws_iam_role" "observer" {
  count       = var.observer_principal_arn == null ? 0 : 1
  name        = var.observer_role_name
  description = "Reads the install's /v1/system/observer routes"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [merge({
      Sid       = "ObserverPrincipal"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = var.observer_principal_arn }
    }, local.external_id_condition)]
  })
}

resource "aws_iam_role_policy" "observer" {
  count = length(aws_iam_role.observer)
  name  = "InvokeObserverRoutes"
  role  = aws_iam_role.observer[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeObserverRoutes"
      Effect   = "Allow"
      Action   = "execute-api:Invoke"
      Resource = local.observer_route_arn
    }]
  })
}
