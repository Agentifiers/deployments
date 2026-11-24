packer {
  required_version = ">= 1.11.0"
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "kms_key_id" {
  type        = string
  description = "Customer managed KMS key that encrypts the AMI's snapshot, so release share-ami can share it."
}

variable "source_commit" {
  type = string
}

locals {
  # The same release and package checksums the module's bootstrap installs.
  clickhouse = jsondecode(file("${path.root}/../../modules/observability-clickhouse/clickhouse-packages.json"))
}

source "amazon-ebs" "clickhouse" {
  ami_name      = "deployments-ai-clickhouse-${local.clickhouse.version}-${var.source_commit}"
  architecture  = "arm64"
  instance_type = "t4g.small"
  region        = var.aws_region
  ssh_username  = "ubuntu"

  source_ami_filter {
    filters = {
      architecture        = "arm64"
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["099720109477"]
  }

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    delete_on_termination = true
    encrypted             = true
    kms_key_id            = var.kms_key_id
    volume_size           = 20
    volume_type           = "gp3"
  }

  tags = {
    ClickHouseVersion = local.clickhouse.version
    ManagedBy         = "packer"
    Product           = "deployments-ai-platform"
    Runtime           = "agent-observability"
    SourceCommit      = var.source_commit
  }
}

build {
  name    = "observability-clickhouse"
  sources = ["source.amazon-ebs.clickhouse"]

  provisioner "shell" {
    environment_vars = [
      "CLICKHOUSE_VERSION=${local.clickhouse.version}",
      "CLICKHOUSE_PACKAGES=${join(" ", [for package, sha256 in local.clickhouse.arm64_sha256 : "${package}=${sha256}"])}",
    ]
    script = "${path.root}/install-clickhouse.sh"
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest.json"
    strip_path = true
  }
}
