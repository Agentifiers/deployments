locals {
  sorted_availability_zones = sort(distinct(var.availability_zones))
  azs                       = { for index, zone in local.sorted_availability_zones : zone => index }
  gateway_nat_azs           = var.nat_mode == "gateway" ? (var.single_nat_gateway ? { shared = 0 } : local.azs) : {}
  private_or_reserved_ipv4_cidrs = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ]
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  for_each = local.azs

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.cidr_block, 8, each.value)
  map_public_ip_on_launch = true

  tags = merge(var.tags, { Name = "${var.name}-public-${each.key}" })
}

resource "aws_subnet" "private" {
  for_each = local.azs

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.cidr_block, 8, each.value + 32)

  tags = merge(var.tags, { Name = "${var.name}-private-${each.key}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  for_each = local.gateway_nat_azs

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-${each.key}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  for_each = aws_eip.nat

  allocation_id = each.value.id
  subnet_id     = var.single_nat_gateway ? values(aws_subnet.public)[0].id : aws_subnet.public[each.key].id

  tags = merge(var.tags, { Name = "${var.name}-nat-${each.key}" })
}

resource "aws_security_group" "nat_instance" {
  count = var.nat_mode == "instance" ? 1 : 0

  name_prefix = "${var.name}-nat-"
  description = "Private subnet egress through the development NAT instance"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-nat-instance" })
}

resource "aws_network_interface" "nat_instance" {
  count = var.nat_mode == "instance" ? 1 : 0

  subnet_id         = values(aws_subnet.public)[0].id
  security_groups   = [aws_security_group.nat_instance[0].id]
  source_dest_check = false

  tags = merge(var.tags, { Name = "${var.name}-nat-instance" })
}

resource "aws_instance" "nat" {
  count = var.nat_mode == "instance" ? 1 : 0

  ami           = var.nat_instance_ami_id
  instance_type = var.nat_instance_type
  user_data     = <<-EOT
    #!/bin/bash
    set -euo pipefail
    install -m 0755 /dev/stdin /usr/local/sbin/fck-nat-deny-reserved-ipv4 <<'SCRIPT'
    #!/bin/bash
    set -euo pipefail
    chain='FCK_NAT_DENY_RESERVED'
    source_cidr='${var.cidr_block}'
    iptables -N "$${chain}" 2>/dev/null || true
    iptables -F "$${chain}"
    for destination_cidr in ${join(" ", local.private_or_reserved_ipv4_cidrs)}; do
      iptables -A "$${chain}" -s "$${source_cidr}" -d "$${destination_cidr}" -j REJECT
    done
    iptables -C FORWARD -j "$${chain}" 2>/dev/null || iptables -I FORWARD 1 -j "$${chain}"
    SCRIPT
    cat >/etc/systemd/system/fck-nat-deny-reserved-ipv4.service <<'UNIT'
    [Unit]
    Description=Reject private and reserved IPv4 forwarding through fck-nat
    Requires=fck-nat.service
    After=fck-nat.service

    [Service]
    Type=oneshot
    ExecStart=/usr/local/sbin/fck-nat-deny-reserved-ipv4
    RemainAfterExit=yes

    [Install]
    WantedBy=multi-user.target
    UNIT
    systemctl daemon-reload
    systemctl enable --now fck-nat-deny-reserved-ipv4.service
  EOT

  user_data_replace_on_change = true

  network_interface {
    device_index         = 0
    network_interface_id = aws_network_interface.nat_instance[0].id
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = merge(var.tags, { Name = "${var.name}-nat-instance" })
}

resource "aws_eip" "nat_instance" {
  count = var.nat_mode == "instance" ? 1 : 0

  domain            = "vpc"
  network_interface = aws_network_interface.nat_instance[0].id

  tags = merge(var.tags, { Name = "${var.name}-nat-instance" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  for_each = local.azs

  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-private-${each.key}" })
}

resource "aws_route" "private_internet" {
  for_each = local.azs

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = var.nat_mode == "gateway" ? (
    var.single_nat_gateway ? aws_nat_gateway.this["shared"].id : aws_nat_gateway.this[each.key].id
  ) : null
  network_interface_id = var.nat_mode == "instance" ? aws_network_interface.nat_instance[0].id : null

  depends_on = [aws_eip.nat_instance]
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

data "aws_region" "current" {}

# Free gateway endpoint: S3 traffic from private subnets, including ECR image layers, skips the NAT.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]

  tags = merge(var.tags, { Name = "${var.name}-s3" })
}

# Free gateway endpoint: DynamoDB traffic from private subnets, including the
# Web Tools Firecrawl table, skips the NAT.
resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]

  tags = merge(var.tags, { Name = "${var.name}-dynamodb" })
}
