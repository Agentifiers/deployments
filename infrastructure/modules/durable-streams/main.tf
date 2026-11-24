locals {
  name_prefix               = "durable-streams"
  uses_shared_load_balancer = var.shared_load_balancer != null
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "durable-streams"
    },
    var.tags,
  )
}

data "aws_region" "current" {}

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

resource "random_password" "auth_token" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "auth_token" {
  name        = "/durable-streams/auth-token"
  description = "Internal Durable Streams authentication token."
  type        = "SecureString"
  value       = random_password.auth_token.result
  tags        = merge(local.common_tags, { Name = "durable-streams-auth-token" })
}

resource "aws_efs_file_system" "data_unprotected" {
  count = var.file_system_deletion_protection_enabled ? 0 : 1

  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-data" })
}

moved {
  from = aws_efs_file_system.data_dev
  to   = aws_efs_file_system.data_unprotected
}

resource "aws_efs_file_system" "data_protected" {
  count = var.file_system_deletion_protection_enabled ? 1 : 0

  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle {
    prevent_destroy = true
  }

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-data" })
}

locals {
  data_file_system_id = one(concat(
    aws_efs_file_system.data_unprotected[*].id,
    aws_efs_file_system.data_protected[*].id,
  ))
}

resource "aws_efs_backup_policy" "data" {
  file_system_id = local.data_file_system_id

  backup_policy {
    status = "ENABLED"
  }
}

resource "aws_efs_access_point" "data" {
  file_system_id = local.data_file_system_id

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/durable-streams"

    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "0750"
    }
  }

  tags = local.common_tags
}

resource "aws_security_group" "efs" {
  name_prefix = "${local.name_prefix}-efs-"
  description = "Durable Streams EFS mount targets"
  vpc_id      = var.vpc_id
  tags        = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "service" {
  name_prefix = "${local.name_prefix}-service-"
  description = "Durable Streams ECS tasks"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_service" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
}

resource "aws_efs_mount_target" "data" {
  for_each = {
    for index, subnet_id in var.private_subnet_ids : tostring(index) => subnet_id
  }

  file_system_id  = local.data_file_system_id
  security_groups = [aws_security_group.efs.id]
  subnet_id       = each.value
}

resource "aws_security_group" "alb" {
  count = local.uses_shared_load_balancer ? 0 : 1

  name_prefix = "${local.name_prefix}-alb-"
  description = "Private Durable Streams load balancer"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = local.uses_shared_load_balancer ? var.shared_load_balancer.security_group_id : aws_security_group.alb[0].id
  from_port                    = 4437
  to_port                      = 4437
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "shared_alb_from_vpc" {
  count = local.uses_shared_load_balancer ? 1 : 0

  security_group_id = var.shared_load_balancer.security_group_id
  cidr_ipv4         = var.vpc_cidr
  from_port         = 4437
  to_port           = 4437
  ip_protocol       = "tcp"
}

resource "aws_lb" "internal" {
  count = local.uses_shared_load_balancer ? 0 : 1

  name                       = substr(local.name_prefix, 0, 32)
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb[0].id]
  subnets                    = var.private_subnet_ids
  idle_timeout               = 300
  enable_deletion_protection = var.deletion_protection_enabled
  tags                       = local.common_tags
}

resource "aws_lb_target_group" "service" {
  name_prefix          = "dstrm-"
  port                 = 4437
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/healthz"
    timeout             = 5
    unhealthy_threshold = 5
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "http" {
  count = local.uses_shared_load_balancer ? 0 : 1

  load_balancer_arn = aws_lb.internal[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service.arn
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "shared" {
  count = local.uses_shared_load_balancer ? 1 : 0

  load_balancer_arn = var.shared_load_balancer.arn
  port              = 4437
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service.arn
  }

  tags = local.common_tags
}

resource "aws_ecs_cluster" "runtime" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights_enabled ? "enabled" : "disabled"
  }

  tags = local.common_tags
}

resource "aws_ecs_cluster_capacity_providers" "runtime" {
  cluster_name       = aws_ecs_cluster.runtime.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
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

data "aws_iam_policy_document" "execution_secret" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.auth_token.arn]
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name_prefix = "secret-"
  role        = aws_iam_role.execution.id
  policy      = data.aws_iam_policy_document.execution_secret.json
}

resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_ecs_task_definition" "service" {
  family                   = local.name_prefix
  cpu                      = var.compact_task_sizing_enabled ? "256" : "1024"
  memory                   = var.compact_task_sizing_enabled ? "512" : "2048"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "durable-streams"
    image     = var.image
    essential = true
    secrets = [{
      name      = "DURABLE_STREAMS_AUTH_TOKEN"
      valueFrom = aws_ssm_parameter.auth_token.arn
    }]
    portMappings = [{
      containerPort = 4437
      hostPort      = 4437
      protocol      = "tcp"
    }]
    mountPoints = [{
      containerPath = "/data"
      readOnly      = false
      sourceVolume  = "data"
    }]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:4437/healthz"]
      interval    = 30
      retries     = 3
      startPeriod = 30
      timeout     = 5
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  volume {
    name = "data"

    efs_volume_configuration {
      file_system_id     = local.data_file_system_id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "DISABLED"
      }
    }
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "service" {
  name                  = local.name_prefix
  cluster               = aws_ecs_cluster.runtime.arn
  task_definition       = aws_ecs_task_definition.service.arn
  desired_count         = var.desired_count
  wait_for_steady_state = false
  # The provider requires a forced rollout for capacity provider strategy changes.
  force_new_deployment = true

  # A single writer owns the EFS data, so a Spot interruption pauses the service until the
  # replacement task starts; readers resume from their last offset.
  capacity_provider_strategy {
    capacity_provider = var.fargate_spot_enabled ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.service.id]
    subnets          = var.private_subnet_ids
  }

  load_balancer {
    container_name   = "durable-streams"
    container_port   = 4437
    target_group_arn = aws_lb_target_group.service.arn
  }

  depends_on = [
    aws_ecs_cluster_capacity_providers.runtime,
    aws_efs_mount_target.data,
    aws_iam_role_policy.execution_secret,
    aws_iam_role_policy_attachment.execution,
    aws_lb_listener.http,
    aws_lb_listener.shared,
  ]
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_errors" {
  alarm_name          = "${local.name_prefix}-target-5xx"
  alarm_description   = "Durable Streams is returning target 5xx responses."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    LoadBalancer = local.uses_shared_load_balancer ? var.shared_load_balancer.arn_suffix : aws_lb.internal[0].arn_suffix
    TargetGroup  = aws_lb_target_group.service.arn_suffix
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "healthy_targets" {
  count = var.alarms_enabled && var.desired_count > 0 ? 1 : 0

  alarm_name          = "${local.name_prefix}-no-healthy-targets"
  alarm_description   = "Durable Streams has no healthy target while the service is enabled."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    LoadBalancer = local.uses_shared_load_balancer ? var.shared_load_balancer.arn_suffix : aws_lb.internal[0].arn_suffix
    TargetGroup  = aws_lb_target_group.service.arn_suffix
  }

  tags = local.common_tags
}
