locals {
  database_port = 5432
  database_clients = {
    database-function = "apps-database Lambda, the only holder of control-path app database credentials"
    gateway           = "App gateway, which connects to app databases only as app viewer and editor roles"
  }
}

resource "aws_security_group" "cluster" {
  name_prefix = "${local.name}-cluster-"
  description = "Aurora cluster for agent-built apps, reachable only from its client groups"
  vpc_id      = var.vpc_id
  tags        = merge(local.common_tags, { Name = "${local.name}-cluster" })
}

resource "aws_security_group" "client" {
  for_each = local.database_clients

  name_prefix = "${local.name}-${each.key}-"
  description = each.value
  vpc_id      = var.vpc_id
  tags        = merge(local.common_tags, { Name = "${local.name}-${each.key}" })
}

resource "aws_vpc_security_group_ingress_rule" "cluster_from_client" {
  for_each = aws_security_group.client

  security_group_id            = aws_security_group.cluster.id
  referenced_security_group_id = each.value.id
  from_port                    = local.database_port
  to_port                      = local.database_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "client_to_cluster" {
  for_each = aws_security_group.client

  security_group_id            = each.value.id
  referenced_security_group_id = aws_security_group.cluster.id
  from_port                    = local.database_port
  to_port                      = local.database_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "client_https" {
  for_each = aws_security_group.client

  security_group_id = each.value.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_db_subnet_group" "apps" {
  name       = local.name
  subnet_ids = var.private_subnet_ids
  tags       = local.common_tags
}

resource "aws_rds_cluster_parameter_group" "apps" {
  name_prefix = "${local.name}-"
  family      = "aurora-postgresql17"
  tags        = local.common_tags

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_rds_cluster" "apps" {
  cluster_identifier                  = local.name
  engine                              = "aurora-postgresql"
  engine_version                      = "17.11"
  port                                = local.database_port
  master_username                     = "postgres"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true
  enable_http_endpoint                = true
  storage_encrypted                   = true
  db_subnet_group_name                = aws_db_subnet_group.apps.name
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.apps.name
  vpc_security_group_ids              = [aws_security_group.cluster.id]
  backup_retention_period             = 7
  deletion_protection                 = var.deletion_protection_enabled
  skip_final_snapshot                 = !var.deletion_protection_enabled
  final_snapshot_identifier           = var.deletion_protection_enabled ? "${local.name}-final" : null
  tags                                = local.common_tags

  serverlessv2_scaling_configuration {
    min_capacity             = var.min_capacity
    max_capacity             = var.max_capacity
    seconds_until_auto_pause = var.seconds_until_auto_pause
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${local.name}-writer"
  cluster_identifier = aws_rds_cluster.apps.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.apps.engine
  engine_version     = aws_rds_cluster.apps.engine_version
  # engine_version is pinned above; an AWS-applied minor upgrade would make the next plan attempt a downgrade.
  auto_minor_version_upgrade = false
  tags                       = local.common_tags
}
