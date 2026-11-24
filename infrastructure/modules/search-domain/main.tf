locals {
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
  vpc_enabled = var.network != null
  zone_count = var.instance_count == 1 ? 1 : (
    var.instance_count % 3 == 0 ? 3 : 2
  )
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_vpc" "runtime" {
  count = local.vpc_enabled ? 1 : 0
  id    = var.network.vpc_id
}

resource "aws_security_group" "domain" {
  count = local.vpc_enabled ? 1 : 0

  name_prefix = "${var.domain_name}-search-"
  description = "OpenSearch HTTPS access from platform runtimes in the VPC"
  vpc_id      = var.network.vpc_id
  ingress {
    cidr_blocks = [data.aws_vpc.runtime[0].cidr_block]
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
  }
  tags = local.common_tags
}

# Encryption at rest uses the AWS managed aws/es key. The domain policy delegates
# authorization to IAM; each runtime role is scoped to its own index prefix.
resource "aws_opensearch_domain" "this" {
  domain_name = var.domain_name

  advanced_options = {
    # Multi-document APIs must name their index in the request path so IAM
    # index-prefix scoping cannot be bypassed through request bodies.
    "rest.action.multi.allow_explicit_index" = "false"
  }

  auto_tune_options {
    desired_state = startswith(var.instance_type, "t2.") || startswith(var.instance_type, "t3.") ? "DISABLED" : "ENABLED"
  }
  cluster_config {
    instance_count         = var.instance_count
    instance_type          = var.instance_type
    zone_awareness_enabled = var.instance_count > 1
    dynamic "zone_awareness_config" {
      for_each = var.instance_count > 1 ? [1] : []
      content { availability_zone_count = local.zone_count }
    }
  }
  ebs_options {
    ebs_enabled = true
    volume_size = var.volume_size
    volume_type = "gp3"
  }
  encrypt_at_rest { enabled = true }
  node_to_node_encryption { enabled = true }
  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }
  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "es:ESHttp*"
      Resource  = "arn:aws:es:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:domain/${var.domain_name}/*"
    }]
  })
  dynamic "vpc_options" {
    for_each = local.vpc_enabled ? [1] : []
    content {
      security_group_ids = [aws_security_group.domain[0].id]
      subnet_ids         = slice(var.network.private_subnet_ids, 0, min(length(var.network.private_subnet_ids), local.zone_count))
    }
  }
  tags = local.common_tags
}
