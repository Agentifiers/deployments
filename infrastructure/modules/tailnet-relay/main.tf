locals {
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
    Runtime     = "tailnet-relay"
  }, var.tags)
}

data "aws_region" "current" {}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_kms_key" "ebs_managed" {
  key_id = "alias/aws/ebs"
}

# Written by scripts/authorize-tailnet-relay.ts, never by OpenTofu.
resource "aws_ssm_parameter" "auth_key" {
  name        = "/tailnet-relay/${var.name}/auth-key"
  description = "Single-use Tailscale auth key for the ${var.name} relay."
  type        = "SecureString"
  value       = "pending"

  tags = merge(local.common_tags, { Name = "${var.name}-auth-key" })

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "relay" {
  name_prefix          = "${var.name}-"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

# Session Manager agent actions only. AmazonSSMManagedInstanceCore would also grant
# ssm:GetParameter on every parameter, which a tailnet member must not hold.
data "aws_iam_policy_document" "relay" {
  statement {
    actions = [
      "ec2messages:AcknowledgeMessage",
      "ec2messages:DeleteMessage",
      "ec2messages:FailMessage",
      "ec2messages:GetEndpoint",
      "ec2messages:GetMessages",
      "ec2messages:SendReply",
      "ssm:UpdateInstanceInformation",
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.auth_key.arn]
  }
}

resource "aws_iam_role_policy" "relay" {
  name_prefix = "relay-"
  role        = aws_iam_role.relay.id
  policy      = data.aws_iam_policy_document.relay.json
}

resource "aws_iam_instance_profile" "relay" {
  name_prefix = "${var.name}-"
  role        = aws_iam_role.relay.name
  tags        = local.common_tags
}

resource "aws_security_group" "relay" {
  name_prefix = "${var.name}-"
  description = "Tailnet relay reachable only from its client on the forwarded port"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = var.upstream.port
    to_port         = var.upstream.port
    protocol        = "tcp"
    security_groups = [var.client_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = var.name })
}

resource "aws_instance" "relay" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.insecure_value
  associate_public_ip_address = false
  iam_instance_profile        = aws_iam_instance_profile.relay.name
  instance_type               = "t4g.nano"
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [aws_security_group.relay.id]
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/relay-bootstrap.sh.tftpl", {
    auth_key_parameter_name = aws_ssm_parameter.auth_key.name
    aws_region              = data.aws_region.current.region
    tailnet_hostname        = var.tailnet_hostname
    upstream_address        = var.upstream.address
    upstream_port           = var.upstream.port
  })

  root_block_device {
    delete_on_termination = true
    encrypted             = true
    kms_key_id            = data.aws_kms_key.ebs_managed.arn
    volume_type           = "gp3"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
  }

  tags = merge(local.common_tags, { Name = var.name })

  # A newer AMI would replace the instance and drop its tailnet identity; roll it deliberately.
  lifecycle {
    ignore_changes = [ami]
  }

  depends_on = [aws_iam_role_policy.relay]
}
