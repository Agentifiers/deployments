locals {
  has_port = var.container_port != null
  has_alb  = local.has_port && var.route_prefix != ""
  has_secrets = length(var.secrets) + sum(concat(
    [0],
    [for container in var.init_containers : length(container.secrets)],
  )) > 0
  all_secret_arns = distinct(concat(
    values(var.secrets),
    flatten([for container in var.init_containers : values(container.secrets)]),
  ))
  init_container_definitions = [
    for container in var.init_containers : {
      name       = container.name
      image      = container.image
      essential  = false
      command    = container.command
      entryPoint = length(container.entrypoint) > 0 ? container.entrypoint : null
      cpu        = container.cpu
      memory     = container.memory
      dependsOn = [
        for dependency in container.depends_on : {
          containerName = dependency.container_name
          condition     = dependency.condition
        }
      ]
      environment = [
        for name in sort(keys(container.environment)) : {
          name  = name
          value = container.environment[name]
        }
      ]
      secrets = [
        for name in sort(keys(container.secrets)) : {
          name      = name
          valueFrom = container.secrets[name]
        }
      ]
      mountPoints  = []
      portMappings = []
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "init"
        }
      }
    }
  ]
  container_definition = {
    name       = var.name
    image      = var.image
    essential  = true
    command    = length(var.command) > 0 ? var.command : null
    entryPoint = length(var.entrypoint) > 0 ? var.entrypoint : null
    environment = [
      for name in sort(keys(var.environment)) : { name = name, value = var.environment[name] }
    ]
    secrets = [
      for name in sort(keys(var.secrets)) : { name = name, valueFrom = var.secrets[name] }
    ]
    portMappings = local.has_port ? [{
      containerPort = var.container_port
      hostPort      = var.container_port
      protocol      = "tcp"
    }] : []
    mountPoints = var.efs_volume == null ? [] : [{
      containerPath = var.efs_volume.container_path
      sourceVolume  = "data"
      readOnly      = false
    }]
    healthCheck = length(var.health_check_command) == 0 ? null : {
      command     = var.health_check_command
      interval    = 30
      retries     = 3
      startPeriod = 60
      timeout     = 5
    }
    dependsOn = [
      for container in var.init_containers : {
        containerName = container.name
        condition     = "SUCCESS"
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "task_assume" {
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
  name_prefix          = substr("${var.name}-exec-", 0, 38)
  assume_role_policy   = data.aws_iam_policy_document.task_assume.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
  tags                 = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = local.has_secrets ? 1 : 0

  statement {
    actions   = ["ssm:GetParameters"]
    resources = local.all_secret_arns
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = local.has_secrets ? 1 : 0

  name_prefix = "secrets-"
  role        = aws_iam_role.execution.id
  policy      = data.aws_iam_policy_document.execution_secrets[0].json
}

resource "aws_iam_role" "task" {
  name_prefix          = substr("${var.name}-task-", 0, 38)
  assume_role_policy   = data.aws_iam_policy_document.task_assume.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
  tags                 = var.tags
}

resource "aws_iam_role_policy" "task" {
  count = var.create_task_policy ? 1 : 0

  name_prefix = "runtime-"
  role        = aws_iam_role.task.id
  policy      = var.task_policy_json
}

data "aws_iam_policy_document" "task_efs" {
  count = var.efs_volume == null ? 0 : 1

  statement {
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
    ]
    resources = [
      "arn:aws:elasticfilesystem:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:file-system/${var.efs_volume.file_system_id}",
    ]

    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [var.efs_volume.access_point_arn]
    }
  }
}

resource "aws_iam_role_policy" "task_efs" {
  count = var.efs_volume == null ? 0 : 1

  name_prefix = "efs-"
  role        = aws_iam_role.task.id
  policy      = data.aws_iam_policy_document.task_efs[0].json
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-"
  description = "ECS service ${var.name}"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = local.has_alb ? [1] : []
    content {
      from_port       = var.container_port
      to_port         = var.container_port
      protocol        = "tcp"
      security_groups = [var.alb_security_group_id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  skip_destroy             = var.retain_task_definition_revisions
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode(concat(local.init_container_definitions, [local.container_definition]))

  runtime_platform {
    cpu_architecture        = var.architecture
    operating_system_family = "LINUX"
  }

  dynamic "volume" {
    for_each = var.efs_volume == null ? [] : [var.efs_volume]
    content {
      name = "data"
      efs_volume_configuration {
        file_system_id     = volume.value.file_system_id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = split("/", volume.value.access_point_arn)[1]
          iam             = "ENABLED"
        }
      }
    }
  }

  tags = var.tags
}

resource "aws_service_discovery_service" "this" {
  count = local.has_port ? 1 : 0

  name = var.name

  dns_config {
    namespace_id = var.service_discovery_namespace_id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  tags = var.tags
}

resource "aws_lb_target_group" "this" {
  count = local.has_alb ? 1 : 0

  name_prefix          = substr(replace(var.name, "_", "-"), 0, 6)
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = var.health_check_codes
    path                = var.health_check_path
    timeout             = 5
    unhealthy_threshold = 5
  }

  tags = var.tags
}

resource "aws_lb_listener_rule" "this" {
  count = local.has_alb ? 1 : 0

  listener_arn = var.alb_listener_arn
  priority     = var.route_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[0].arn
  }

  condition {
    path_pattern {
      values = [var.route_prefix, "${var.route_prefix}/*"]
    }
  }

  dynamic "transform" {
    for_each = var.rewrite_route_prefix ? [1] : []
    content {
      type = "url-rewrite"
      url_rewrite_config {
        rewrite {
          regex   = "^${var.route_prefix}/?(.*)$"
          replace = "/$1"
        }
      }
    }
  }

  tags = var.tags
}

resource "aws_ecs_service" "this" {
  name                               = var.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  deployment_maximum_percent         = var.deployment_maximum_percent
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  launch_type                        = "FARGATE"
  wait_for_steady_state              = var.wait_for_steady_state

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = var.assign_public_ip
    security_groups  = concat([aws_security_group.this.id], var.additional_security_group_ids)
    subnets          = var.subnet_ids
  }

  dynamic "service_registries" {
    for_each = local.has_port ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.this[0].arn
    }
  }

  dynamic "load_balancer" {
    for_each = local.has_alb ? [1] : []
    content {
      container_name   = var.name
      container_port   = var.container_port
      target_group_arn = aws_lb_target_group.this[0].arn
    }
  }

  tags = var.tags
}
