data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name                 = "${local.name_prefix}-node"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "node" {
  statement {
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:volume/${local.data_volume_id}"]
  }
  statement {
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}::snapshot/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Runtime"
      values   = ["agent-observability"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [var.environment]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["ssm-backup"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/SourceVolumeId"
      values   = [local.data_volume_id]
    }
  }
  statement {
    actions   = ["ec2:CreateTags"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}::snapshot/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateSnapshot"]
    }
  }
  statement {
    actions   = ["ec2:DeleteSnapshot"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}::snapshot/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Runtime"
      values   = ["agent-observability"]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Environment"
      values   = [var.environment]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["ssm-backup"]
    }
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/SourceVolumeId"
      values   = [local.data_volume_id]
    }
  }
  statement {
    actions   = ["ec2:DescribeSnapshots"]
    resources = ["*"]
  }
  statement {
    actions   = ["ec2:DescribeVolumes"]
    resources = ["*"]
  }
  statement {
    actions   = ["ec2:CreateTags"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:volume/${local.data_volume_id}"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/FilesystemState"
      values   = ["formatting", "initialized"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["FilesystemState"]
    }
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = values(aws_ssm_parameter.runtime)[*].arn
  }
  statement {
    actions   = ["s3:AbortMultipartUpload", "s3:DeleteObject", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:PutObject"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["DeploymentsAI/Observability"]
    }
  }
}

resource "aws_iam_role_policy" "node" {
  name   = "${local.name_prefix}-node"
  role   = aws_iam_role.node.id
  policy = data.aws_iam_policy_document.node.json
}

resource "aws_iam_instance_profile" "node" {
  name = "${local.name_prefix}-node"
  role = aws_iam_role.node.name
  tags = local.common_tags
}

resource "aws_security_group" "node" {
  name_prefix = "${local.name_prefix}-node-"
  description = "Private TLS-only ClickHouse node"
  vpc_id      = var.vpc_id

  ingress {
    description     = "ClickHouse HTTPS from hot-plane tasks"
    from_port       = 8443
    to_port         = 8443
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}

# Volumes name the AWS managed EBS key explicitly; kms_key_id is computed, so omitting it would keep
# whatever key a volume was created with.
data "aws_kms_key" "ebs_managed" {
  key_id = "alias/aws/ebs"
}

# EBS volumes cannot shrink, so a size below the live volume's keeps the live size. That lets
# installs created with a larger volume take a smaller default, and keeps a volume an operator grew
# outside OpenTofu.
data "aws_ebs_volumes" "existing_data" {
  filter {
    name   = "tag:Name"
    values = ["${local.name_prefix}-data"]
  }
  filter {
    name   = "tag:Environment"
    values = [local.common_tags["Environment"]]
  }
}

data "aws_ebs_volume" "existing_data" {
  for_each = toset(data.aws_ebs_volumes.existing_data.ids)

  filter {
    name   = "volume-id"
    values = [each.value]
  }
}

locals {
  data_volume_size_gib = max(var.data_volume_size_gib, [for volume in data.aws_ebs_volume.existing_data : volume.size]...)
}

resource "aws_ebs_volume" "data_unprotected" {
  count             = var.deletion_protection_enabled ? 0 : 1
  availability_zone = data.aws_subnet.selected.availability_zone
  encrypted         = true
  final_snapshot    = false
  iops              = var.data_volume_iops
  kms_key_id        = data.aws_kms_key.ebs_managed.arn
  size              = local.data_volume_size_gib
  throughput        = var.data_volume_throughput
  type              = "gp3"
  tags              = merge(local.common_tags, { Name = "${local.name_prefix}-data", Generation = "1", FilesystemState = "uninitialized" })

  lifecycle { ignore_changes = [tags["FilesystemState"]] }
}

moved {
  from = aws_ebs_volume.data_dev
  to   = aws_ebs_volume.data_unprotected
}

resource "aws_ebs_volume" "data_protected" {
  count             = var.deletion_protection_enabled ? 1 : 0
  availability_zone = data.aws_subnet.selected.availability_zone
  encrypted         = true
  final_snapshot    = true
  iops              = var.data_volume_iops
  kms_key_id        = data.aws_kms_key.ebs_managed.arn
  size              = local.data_volume_size_gib
  throughput        = var.data_volume_throughput
  type              = "gp3"
  tags              = merge(local.common_tags, { Name = "${local.name_prefix}-data", Generation = "1", FilesystemState = "uninitialized" })

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [tags["FilesystemState"]]
  }
}

resource "aws_instance" "node" {
  ami                         = local.ami_id
  associate_public_ip_address = false
  availability_zone           = data.aws_subnet.selected.availability_zone
  iam_instance_profile        = aws_iam_instance_profile.node.name
  instance_type               = var.instance_type
  monitoring                  = var.detailed_monitoring_enabled
  disable_api_termination     = var.deletion_protection_enabled
  force_destroy               = var.deletion_protection_enabled
  subnet_id                   = data.aws_subnet.selected.id
  vpc_security_group_ids      = [aws_security_group.node.id]
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/clickhouse-bootstrap.sh.tftpl", {
    aws_region                       = data.aws_region.current.region
    backup_bucket                    = aws_s3_bucket.backups.id
    client_cidr                      = var.vpc_cidr
    clickhouse_package_sha256        = local.clickhouse_packages.arm64_sha256
    clickhouse_version               = local.clickhouse_packages.version
    data_volume_id                   = local.data_volume_id
    environment                      = var.environment
    admin_password_parameter_arn     = aws_ssm_parameter.runtime["admin-password"].arn
    ca_certificate_parameter_arn     = aws_ssm_parameter.runtime["ca-certificate"].arn
    ingest_password_parameter_arn    = aws_ssm_parameter.runtime["ingest-password"].arn
    query_password_parameter_arn     = aws_ssm_parameter.runtime["query-password"].arn
    runtime_parameter_versions       = join(",", [for parameter in values(aws_ssm_parameter.runtime) : tostring(parameter.version)])
    server_certificate_parameter_arn = aws_ssm_parameter.runtime["server-certificate"].arn
    server_private_key_parameter_arn = aws_ssm_parameter.runtime["server-private-key"].arn
    server_memory_bytes              = coalesce(var.server_memory_bytes, 0)
    server_memory_to_ram_ratio       = var.server_memory_bytes == null ? local.server_memory_to_ram_ratio : 0.9
  })

  root_block_device {
    delete_on_termination = true
    encrypted             = true
    kms_key_id            = data.aws_kms_key.ebs_managed.arn
    volume_size           = var.root_volume_size_gib
    volume_type           = "gp3"
  }

  # T4g launches unlimited by default; pinning it keeps sustained load at full speed instead of
  # throttling to the baseline. The surplus-credit alarm reports what that costs.
  dynamic "credit_specification" {
    for_each = local.burstable ? [1] : []
    content { cpu_credits = "unlimited" }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
    instance_metadata_tags      = "enabled"
  }

  depends_on = [aws_ebs_volume.data_unprotected, aws_ebs_volume.data_protected, aws_ssm_parameter.runtime]
  tags       = merge(local.common_tags, { Name = local.name_prefix, State = "running" })
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  instance_id                    = aws_instance.node.id
  stop_instance_before_detaching = true
  volume_id                      = local.data_volume_id
}

resource "aws_service_discovery_service" "node" {
  name = "clickhouse"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.private.id

    dns_records {
      ttl  = 30
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  tags = local.common_tags
}

resource "aws_service_discovery_instance" "node" {
  instance_id = aws_instance.node.id
  service_id  = aws_service_discovery_service.node.id

  attributes = {
    AWS_INSTANCE_IPV4 = aws_instance.node.private_ip
  }
}
