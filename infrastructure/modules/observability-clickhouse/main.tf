data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

data "aws_subnet" "selected" {
  id = var.private_subnet_ids[0]
}

data "aws_ami" "ubuntu_arm64" {
  count       = trimspace(var.ami_id) == "" ? 1 : 0
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Keeps the Ubuntu image resolved at the first apply, so a new Canonical release never replaces
# the node on a routine deploy.
resource "terraform_data" "base_ami" {
  count = trimspace(var.ami_id) == "" ? 1 : 0

  input = data.aws_ami.ubuntu_arm64[0].id

  lifecycle {
    ignore_changes = [input]
  }
}

locals {
  name_prefix = "agent-observability-hot"
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
    Runtime     = "agent-observability"
  }, var.tags)
  ami_id    = trimspace(var.ami_id) == "" ? terraform_data.base_ami[0].output : trimspace(var.ami_id)
  burstable = startswith(var.instance_type, "t4g.")
  # ClickHouse's share of the node's RAM when no explicit cap is set: about 2.8 GB on a t4g.medium,
  # the cap proven there, and about 11.5 GB on an r7g.large. The rest is for the OS, the SSM agent,
  # the AWS CLI during backups, and allocator memory ClickHouse does not track.
  server_memory_to_ram_ratio = 0.7
  # The ClickHouse release and the SHA-256 of each arm64 package the node installs; the Packer
  # bake reads the same file.
  clickhouse_packages = jsondecode(file("${path.module}/clickhouse-packages.json"))
  data_volume_id      = var.deletion_protection_enabled ? aws_ebs_volume.data_protected[0].id : aws_ebs_volume.data_unprotected[0].id
  database_host       = "clickhouse.observability.internal"
  runtime_parameter_values = {
    "admin-password"     = random_password.admin.result
    "ca-certificate"     = tls_self_signed_cert.ca.cert_pem
    "ingest-password"    = random_password.ingest.result
    "query-password"     = random_password.query.result
    "server-certificate" = tls_locally_signed_cert.server.cert_pem
    "server-private-key" = tls_private_key.server.private_key_pem
  }
  fact_stream_name = element(
    split("/", var.fact_stream_arn),
    length(split("/", var.fact_stream_arn)) - 1,
  )
}

resource "random_password" "admin" {
  length  = 48
  special = false
}

resource "random_password" "ingest" {
  length  = 48
  special = false
}

resource "random_password" "query" {
  length  = 48
  special = false
}

resource "random_password" "service" {
  length  = 64
  special = false
}

resource "tls_private_key" "ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P384"
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 43800
  early_renewal_hours   = 720
  allowed_uses          = ["cert_signing", "crl_signing", "digital_signature"]
  subject {
    common_name  = "Deployments.ai observability ${var.environment} CA"
    organization = "Deployments.ai"
  }
}

resource "tls_private_key" "server" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P384"
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem
  dns_names       = [local.database_host]
  subject {
    common_name  = local.database_host
    organization = "Deployments.ai"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem      = tls_cert_request.server.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 8760
  early_renewal_hours   = 720
  allowed_uses          = ["server_auth", "digital_signature", "key_encipherment"]
}

resource "aws_ssm_parameter" "runtime" {
  for_each = local.runtime_parameter_values

  name        = "/${local.name_prefix}/${var.environment}/runtime/${each.key}"
  description = "ClickHouse TLS or database credential material."
  type        = "SecureString"
  key_id      = "alias/aws/ssm"
  value       = each.value
  tags        = merge(local.common_tags, { Name = each.key })
}

resource "aws_ssm_parameter" "service" {
  name        = "/${local.name_prefix}/${var.environment}/service-token"
  description = "Internal hot-plane API service credential."
  type        = "SecureString"
  key_id      = "alias/aws/ssm"
  value       = random_password.service.result
  tags        = local.common_tags
}

resource "aws_service_discovery_private_dns_namespace" "private" {
  name        = "observability.internal"
  description = "Private discovery for the observability hot plane"
  vpc         = var.vpc_id
  tags        = local.common_tags
}
