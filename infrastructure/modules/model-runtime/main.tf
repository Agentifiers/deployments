locals {
  name_prefix = "models"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "model-gateway"
    },
    var.tags,
  )

  bedrock_hosted = contains(var.hosted_providers, "bedrock")

  provider_key_parameter_names = toset(concat(
    contains(var.hosted_providers, "openai") ? ["openai-api-key"] : [],
    contains(var.hosted_providers, "openrouter") ? ["openrouter-api-key"] : [],
  ))
  parameter_names = setunion(["model-grants-json"], local.provider_key_parameter_names)

  # The gateway verifies tokens signed by the current key and, during a rotation, by previous keys.
  trusted_signing_key_arns = concat([aws_kms_key.token_signing.arn], var.model_gateway_previous_signing_key_arns)

  model_gateway_base_url = "http://${aws_lb.internal.dns_name}"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

# Provider API keys and operator model grants; written by the deploy tool, never by OpenTofu.
resource "aws_ssm_parameter" "runtime" {
  for_each = local.parameter_names

  name        = "/models/${each.key}"
  description = "Model runtime value managed by the deploy tool."
  type        = "SecureString"
  tier        = "Intelligent-Tiering"
  value       = "pending"

  tags = merge(local.common_tags, { Name = each.key })

  lifecycle {
    ignore_changes = [value]
  }
}

# Signs model gateway tokens. Only the token issuer roles hold kms:Sign; the gateway verifies with
# the public key. Asymmetric keys cannot rotate automatically: rotate by creating a new key and
# listing the old ARN in model_gateway_previous_signing_key_arns until its tokens expire.
resource "aws_kms_key" "token_signing" {
  description              = "Model gateway token signing key"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = var.kms_deletion_window_in_days
  enable_key_rotation      = false

  tags = merge(local.common_tags, { Name = "model-gateway-token" })
}

resource "aws_kms_alias" "token_signing" {
  name          = "alias/${local.name_prefix}-model-gateway-token"
  target_key_id = aws_kms_key.token_signing.key_id
}

resource "aws_ecs_cluster" "runtime" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights_enabled ? "enabled" : "disabled"
  }

  tags = local.common_tags
}

# Services on this cluster (model gateway, agent worker, web tools) pick FARGATE or FARGATE_SPOT
# through their own capacity provider strategy; the cluster keeps no default strategy.
resource "aws_ecs_cluster_capacity_providers" "runtime" {
  cluster_name       = aws_ecs_cluster.runtime.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-"
  description = "Internal model gateway load balancer"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_vpc" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_from_clients" {
  for_each = var.https_client_security_group_ids

  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = each.value
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_all_ipv4" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_lb" "internal" {
  name               = substr("${local.name_prefix}-internal", 0, 32)
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.private_subnet_ids
  idle_timeout       = 900

  enable_deletion_protection = var.deletion_protection_enabled

  tags = local.common_tags
}

resource "aws_security_group" "gateway" {
  name_prefix = "${local.name_prefix}-gateway-"
  description = "Model gateway ECS service"
  vpc_id      = var.vpc_id

  # Only the gateway port is reachable; Bifrost listens on the task loopback.
  ingress {
    from_port       = local.gateway_port
    to_port         = local.gateway_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "gateway" {
  name_prefix          = "mdlgw-"
  port                 = local.gateway_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 600

  # /health answers 200 only while the gateway reaches Bifrost.
  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/health"
    timeout             = 5
    unhealthy_threshold = 5
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  tags = local.common_tags
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    effect  = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix          = "${local.name_prefix}-exec-"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(local.provider_key_parameter_names) > 0 ? 1 : 0

  statement {
    actions   = ["ssm:GetParameters"]
    resources = [for name in sort(tolist(local.provider_key_parameter_names)) : aws_ssm_parameter.runtime[name].arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(local.provider_key_parameter_names) > 0 ? 1 : 0

  name_prefix = "secrets-"
  role        = aws_iam_role.execution.id
  policy      = data.aws_iam_policy_document.execution_secrets[0].json
}

# Bifrost and the gateway share this task role.
resource "aws_iam_role" "task" {
  name_prefix          = "${local.name_prefix}-task-"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "gateway" {
  statement {
    sid       = "VerifyTokenSignatures"
    actions   = ["kms:GetPublicKey"]
    resources = local.trusted_signing_key_arns
  }

  statement {
    sid       = "ReadRunLeases"
    actions   = ["dynamodb:GetItem"]
    resources = [var.execution_table_arn]
  }

  # Organization standing (the spend ceiling) and, when enabled, sealed organization provider keys.
  statement {
    sid       = "ReadOrganizationControlRecords"
    actions   = ["dynamodb:GetItem"]
    resources = [var.control_table_arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["ORG#*"]
    }
  }

  statement {
    sid       = "ReadOrganizationMonthSpend"
    actions   = ["dynamodb:Query"]
    resources = [var.usage_table_arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["ORG#*#SPEND#ORGANIZATION"]
    }
  }

  # The dedicated key's policy grants the same decrypt; it opens only model provider credentials.
  dynamic "statement" {
    for_each = var.model_credentials == null ? [] : [var.model_credentials]

    content {
      sid       = "OpenOrganizationModelCredentials"
      actions   = ["kms:Decrypt"]
      resources = [statement.value.kms_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:purpose"
        values   = ["model-provider-credential"]
      }
    }
  }
}

resource "aws_iam_role_policy" "gateway" {
  name_prefix = "gateway-"
  role        = aws_iam_role.task.id
  policy      = data.aws_iam_policy_document.gateway.json
}

# Bedrock has no API key: Bifrost signs requests with this task role through the
# AWS SDK default credential chain. Model access enablement stays an operator action.
data "aws_iam_policy_document" "bedrock" {
  count = local.bedrock_hosted ? 1 : 0

  # Converse/ConverseStream authorize as InvokeModel/InvokeModelWithResponseStream on the
  # in-region foundation model or system-defined inference profile named by the request.
  statement {
    sid     = "InvokeInRegion"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:${data.aws_region.current.region}::foundation-model/*",
      "arn:${data.aws_partition.current.partition}:bedrock:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
    ]
  }

  # Cross-region profiles also evaluate the destination foundation models: geo profiles use
  # destination-region ARNs, global profiles the region-less ARN. Allow them only when routed
  # through one of this account's in-region inference profiles.
  statement {
    sid     = "CrossRegionInferenceDestinations"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
      "arn:${data.aws_partition.current.partition}:bedrock:::foundation-model/*",
    ]

    condition {
      test     = "StringLike"
      variable = "bedrock:InferenceProfileArn"
      values   = ["arn:${data.aws_partition.current.partition}:bedrock:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:inference-profile/*"]
    }
  }

  # Bifrost sends bare OpenAI-family, Grok, and Gemma 4 ids to the bedrock-mantle
  # endpoint, which signs requests as the bedrock-mantle service.
  statement {
    sid       = "MantleInference"
    actions   = ["bedrock-mantle:CreateInference"]
    resources = ["arn:${data.aws_partition.current.partition}:bedrock-mantle:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:project/*"]
  }

  # Bifrost lists foundation models at startup and for /v1/models; the action has no resource type.
  statement {
    sid       = "ListFoundationModels"
    actions   = ["bedrock:ListFoundationModels"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [data.aws_region.current.region]
    }
  }
}

resource "aws_iam_role_policy" "bedrock" {
  count = local.bedrock_hosted ? 1 : 0

  name_prefix = "bedrock-"
  role        = aws_iam_role.task.id
  policy      = data.aws_iam_policy_document.bedrock[0].json
}
