locals {
  gateway_name        = "${local.name}-gateway"
  gateway_port        = 8080
  gateway_health_path = "/_platform/healthz"
  oauth_client_id     = "deployments-apps"
  # A SecureString the deploy tool's identity client bootstrap writes; OpenTofu only names it.
  oauth_client_secret_arn = "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/identity/${local.name}-oauth-client"
  gateway_environment = {
    APPS_BUCKET                     = aws_s3_bucket.apps.bucket
    APPS_DATABASE_HOST              = aws_rds_cluster.apps.endpoint
    APPS_DATABASE_PORT              = tostring(local.database_port)
    APPS_DATABASE_REGION            = data.aws_region.current.region
    APPS_DOMAIN                     = var.domain
    APPS_OAUTH_CLIENT_ID            = local.oauth_client_id
    APPS_OAUTH_CLIENT_SECRET_ARN    = local.oauth_client_secret_arn
    APPS_VISITOR_ADDRESS_BURST      = "10"
    APPS_VISITOR_ADDRESS_PER_MINUTE = "10"
    APPS_VISITOR_APP_BURST          = "120"
    APPS_VISITOR_APP_PER_MINUTE     = "300"
    APPS_VISITOR_BODY_MAX_BYTES     = "16384"
    APPS_VISITOR_CALLS_PER_APP      = "2"
    APPS_VISITOR_CALLS_TOTAL        = "16"
    APPS_VISITOR_PAGE_BURST         = "60"
    APPS_VISITOR_PAGE_PER_MINUTE    = "300"
    DEPLOYMENTS_AI_CONTROL_TABLE    = var.control_table.name
    DEPLOYMENTS_AI_IDENTITY_ISSUER  = var.identity_issuer
    DEPLOYMENTS_AI_IDENTITY_TABLE   = var.identity_table.name
  }
}

resource "aws_vpc_security_group_ingress_rule" "gateway_from_load_balancer" {
  security_group_id            = aws_security_group.client["gateway"].id
  referenced_security_group_id = var.internal_load_balancer.security_group_id
  from_port                    = local.gateway_port
  to_port                      = local.gateway_port
  ip_protocol                  = "tcp"
}

# The Secrets Manager secret of earlier releases stays in the account until an operator deletes it.
removed {
  from = aws_secretsmanager_secret.oauth_client
  lifecycle { destroy = false }
}

removed {
  from = aws_secretsmanager_secret_policy.oauth_client
  lifecycle { destroy = false }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "gateway_execution" {
  name                 = "apps-gateway-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "gateway_execution" {
  role       = aws_iam_role.gateway_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "gateway_task" {
  name                 = "apps-gateway-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "gateway_task" {
  statement {
    sid       = "ReadAppRecords"
    actions   = ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"]
    resources = [var.control_table.arn, "${var.control_table.arn}/index/*"]
  }

  statement {
    sid = "ManageAppSessions"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.identity_table.arn, "${var.identity_table.arn}/index/*"]
  }

  statement {
    sid     = "ConnectAsAppApiRoles"
    actions = ["rds-db:connect"]
    resources = [
      "${local.database_users}/app_*_viewer",
      "${local.database_users}/app_*_editor",
      "${local.database_users}/app_*_visitor",
    ]
  }

  statement {
    sid       = "ReadReleaseObjects"
    actions   = ["s3:GetObject"]
    resources = [local.release_objects]
  }

  statement {
    sid       = "ReadOAuthClientSecret"
    actions   = ["ssm:GetParameter"]
    resources = [local.oauth_client_secret_arn]
  }
}

resource "aws_iam_role_policy" "gateway_task" {
  name   = "apps-gateway"
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.gateway_task.json
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${local.gateway_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_ecs_cluster" "apps" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = var.container_insights_enabled ? "enabled" : "disabled"
  }

  tags = local.common_tags
}

resource "aws_ecs_cluster_capacity_providers" "apps" {
  cluster_name       = aws_ecs_cluster.apps.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = local.gateway_name
  cpu                      = var.compact_task_sizing_enabled ? "256" : "512"
  memory                   = var.compact_task_sizing_enabled ? "512" : "1024"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.gateway_execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn

  container_definitions = jsonencode([{
    name        = "app-gateway"
    image       = var.gateway_image
    essential   = true
    stopTimeout = 30
    environment = [
      for name in sort(keys(local.gateway_environment)) : {
        name  = name
        value = local.gateway_environment[name]
      }
    ]
    portMappings = [{
      containerPort = local.gateway_port
      hostPort      = local.gateway_port
      protocol      = "tcp"
    }]
    healthCheck = {
      command = [
        "CMD",
        "bun",
        "-e",
        "const r = await fetch('http://127.0.0.1:${local.gateway_port}${local.gateway_health_path}'); process.exit(r.status === 200 ? 0 : 1)",
      ]
      interval    = 30
      retries     = 3
      startPeriod = 15
      timeout     = 5
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.gateway.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  tags = local.common_tags
}

resource "aws_lb_target_group" "gateway" {
  name_prefix          = "appgw-"
  port                 = local.gateway_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = local.gateway_health_path
    timeout             = 5
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "gateway" {
  load_balancer_arn = var.internal_load_balancer.arn
  port              = local.gateway_listener_port
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.origin.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "gateway" {
  name                  = local.gateway_name
  cluster               = aws_ecs_cluster.apps.arn
  task_definition       = aws_ecs_task_definition.gateway.arn
  desired_count         = var.high_availability_enabled ? 2 : 1
  wait_for_steady_state = false
  # The provider requires a forced rollout for capacity provider strategy changes.
  force_new_deployment = true

  capacity_provider_strategy {
    capacity_provider = var.fargate_spot_enabled ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 30

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [aws_security_group.client["gateway"].id]
    subnets          = var.private_subnet_ids
  }

  load_balancer {
    container_name   = "app-gateway"
    container_port   = local.gateway_port
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  depends_on = [
    aws_ecs_cluster_capacity_providers.apps,
    aws_iam_role_policy.gateway_task,
    aws_iam_role_policy_attachment.gateway_execution,
    aws_lb_listener.gateway,
  ]
  tags = local.common_tags
}
