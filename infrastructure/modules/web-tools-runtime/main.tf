locals {
  name_prefix = "web-tools"
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "web-tools"
    },
    var.tags,
  )
  secret_names = toset([
    "firecrawl-job-ticket",
    "firecrawl-searxng-secret",
  ])
  table_name = "${local.name_prefix}-firecrawl"
  task_egress_ipv4_cidrs = [
    "1.0.0.0/8",
    "2.0.0.0/7",
    "4.0.0.0/6",
    "8.0.0.0/7",
    "11.0.0.0/8",
    "12.0.0.0/6",
    "16.0.0.0/4",
    "32.0.0.0/3",
    "64.0.0.0/3",
    "96.0.0.0/6",
    "100.0.0.0/10",
    "100.128.0.0/9",
    "101.0.0.0/8",
    "102.0.0.0/7",
    "104.0.0.0/5",
    "112.0.0.0/5",
    "120.0.0.0/6",
    "124.0.0.0/7",
    "126.0.0.0/8",
    "128.0.0.0/3",
    "160.0.0.0/5",
    "168.0.0.0/8",
    "169.0.0.0/9",
    "169.128.0.0/10",
    "169.192.0.0/11",
    "169.224.0.0/12",
    "169.240.0.0/13",
    "169.248.0.0/14",
    "169.252.0.0/15",
    "169.255.0.0/16",
    "170.0.0.0/7",
    "172.0.0.0/12",
    "172.32.0.0/11",
    "172.64.0.0/10",
    "172.128.0.0/9",
    "173.0.0.0/8",
    "174.0.0.0/7",
    "176.0.0.0/4",
    "192.0.0.0/9",
    "192.128.0.0/11",
    "192.160.0.0/13",
    "192.169.0.0/16",
    "192.170.0.0/15",
    "192.172.0.0/14",
    "192.176.0.0/12",
    "192.192.0.0/10",
    "193.0.0.0/8",
    "194.0.0.0/7",
    "196.0.0.0/6",
    "200.0.0.0/5",
    "208.0.0.0/4",
  ]

  searxng_command = <<-EOT
    set -eu
    cat >/tmp/searxng-settings.yml <<EOF
    use_default_settings: true
    server:
      bind_address: "0.0.0.0"
      port: 8080
      secret_key: "$${SEARXNG_SECRET}"
    search:
      formats:
        - html
        - json
    outgoing:
      proxies:
        all://:
          - http://127.0.0.1:3335
    EOF
    export SEARXNG_SETTINGS_PATH=/tmp/searxng-settings.yml
    export __SEARXNG_SETTINGS_PATH=/tmp/searxng-settings.yml
    exec /usr/local/searxng/entrypoint.sh
  EOT

  proxy_command = <<-EOT
    import { createBrowserEgressProxy } from './packages/web-tools-proxy/src/egress-proxy.ts';
    import { createModelGatewayProxy } from './packages/web-tools-proxy/src/model-gateway-proxy.ts';
    createBrowserEgressProxy().listen(3335, '0.0.0.0');
    createModelGatewayProxy({
      baseUrl: process.env.MODEL_GATEWAY_BASE_URL,
      tokenIssuer: process.env.MODEL_GATEWAY_TOKEN_ISSUER,
      hostname: '0.0.0.0',
      port: 3336,
    });
  EOT
}

data "aws_region" "current" {}

data "aws_vpc" "runtime" {
  id = var.vpc_id
}

data "aws_lb" "runtime" {
  arn = var.load_balancer_arn
}

resource "aws_ssm_parameter" "runtime" {
  for_each = local.secret_names

  name        = "/web-tools/${each.key}"
  description = "Static credential for the self-hosted web tools runtime."
  type        = "SecureString"
  value = {
    "firecrawl-job-ticket"     = random_password.job_ticket.result
    "firecrawl-searxng-secret" = random_password.searxng.result
  }[each.key]
  tags = merge(local.common_tags, { Name = each.key })
}

resource "random_password" "searxng" {
  length  = 48
  special = false
}

resource "random_password" "job_ticket" {
  length  = 48
  special = false
}

# Firecrawl's queue (NuQ), crawl store and extract/deep-research/llms.txt
# status documents. The shape is var.firecrawl_table: the definition the
# deployed var.firecrawl_image ships at /app/dynamodb-table.json, exported
# from that image by the release build.
resource "aws_dynamodb_table" "firecrawl" {
  name         = local.table_name
  billing_mode = var.firecrawl_table.billing_mode
  hash_key     = var.firecrawl_table.hash_key
  range_key    = var.firecrawl_table.range_key

  deletion_protection_enabled = var.deletion_protection_enabled

  dynamic "attribute" {
    for_each = var.firecrawl_table.attributes

    content {
      name = attribute.value.name
      type = attribute.value.type
    }
  }

  dynamic "global_secondary_index" {
    for_each = var.firecrawl_table.global_secondary_indexes
    iterator = gsi

    content {
      name               = gsi.value.name
      projection_type    = gsi.value.projection_type
      non_key_attributes = gsi.value.non_key_attributes

      # The first key is the partition (HASH) key, the optional second the sort (RANGE) key.
      dynamic "key_schema" {
        for_each = compact([gsi.value.hash_key, gsi.value.range_key])

        content {
          attribute_name = key_schema.value
          key_type       = key_schema.key == 0 ? "HASH" : "RANGE"
        }
      }
    }
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery_enabled
  }

  # enabled = false selects the AWS owned key; omitting the block would keep a prior key.
  server_side_encryption {
    enabled = false
  }

  ttl {
    attribute_name = var.firecrawl_table.ttl_attribute
    enabled        = true
  }

  tags = merge(local.common_tags, { Name = local.table_name })
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
  statement {
    actions   = ["ssm:GetParameters"]
    resources = values(aws_ssm_parameter.runtime)[*].arn
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name_prefix = "secrets-"
  role        = aws_iam_role.execution.id
  policy      = data.aws_iam_policy_document.execution_secrets.json
}

# The proxy sidecar mints web-tools model gateway tokens; Firecrawl itself holds
# no model credential and uses the role only for its DynamoDB table.
resource "aws_iam_role" "task" {
  name_prefix          = "${local.name_prefix}-task-"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "InvokeModelTokenIssuer"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.model_gateway_token_issuer.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name_prefix = "model-tokens-"
  role        = aws_iam_role.task.id
  policy      = data.aws_iam_policy_document.task.json
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

# Item-level access to the one Firecrawl table and its indexes. Transactions
# need the per-item actions; there is no Scan, table management, or stream
# access.
data "aws_iam_policy_document" "task_dynamodb" {
  statement {
    sid = "FirecrawlTableItems"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [
      aws_dynamodb_table.firecrawl.arn,
      "${aws_dynamodb_table.firecrawl.arn}/index/*",
    ]
  }
}

resource "aws_iam_role_policy" "task_dynamodb" {
  name_prefix = "dynamodb-"
  role        = aws_iam_role.task.id
  policy      = data.aws_iam_policy_document.task_dynamodb.json
}
