locals {
  name_prefix    = "stream-gateway"
  container_name = "stream-gateway"
  container_port = 8080
  # Without a dedicated public ALB, viewers reach the gateway through CloudFront and a VPC origin
  # on the shared internal ALB (edge.tf).
  uses_shared_load_balancer = var.shared_load_balancer != null
  # Port of the gateway's HTTPS listener on the shared internal ALB; its 80, 443, and 4437
  # listeners belong to the model gateway, Firecrawl, and Durable Streams.
  shared_listener_port     = 8443
  load_balancer_arn_suffix = local.uses_shared_load_balancer ? var.shared_load_balancer.arn_suffix : aws_lb.public[0].arn_suffix
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
      Runtime     = "stream-gateway"
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

# The platform network has no IPv6 CIDRs, so the public load balancer is IPv4-only.
resource "aws_security_group" "alb" {
  count = local.uses_shared_load_balancer ? 0 : 1

  name_prefix = "${local.name_prefix}-alb-"
  description = "Public stream gateway load balancer"
  vpc_id      = var.vpc_id
  tags        = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "service" {
  name_prefix = "${local.name_prefix}-service-"
  description = "Stream gateway ECS tasks"
  vpc_id      = var.vpc_id
  tags        = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count = local.uses_shared_load_balancer ? 0 : 1

  security_group_id = aws_security_group.alb[0].id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  count = local.uses_shared_load_balancer ? 0 : 1

  security_group_id            = aws_security_group.alb[0].id
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = local.container_port
  to_port                      = local.container_port
  ip_protocol                  = "tcp"
}

# The shared internal ALB already allows all IPv4 egress (model-runtime module).
resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = local.uses_shared_load_balancer ? var.shared_load_balancer.security_group_id : aws_security_group.alb[0].id
  from_port                    = local.container_port
  to_port                      = local.container_port
  ip_protocol                  = "tcp"
}

# The shared internal ALB already admits tcp 4437 from the VPC CIDR (durable-streams module).
resource "aws_vpc_security_group_egress_rule" "service_to_durable_streams" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = var.durable_streams_load_balancer_security_group_id
  from_port                    = 4437
  to_port                      = 4437
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_https" {
  security_group_id = aws_security_group.service.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_lb" "public" {
  count = local.uses_shared_load_balancer ? 0 : 1

  name                       = local.name_prefix
  internal                   = false
  load_balancer_type         = "application"
  ip_address_type            = "ipv4"
  security_groups            = [aws_security_group.alb[0].id]
  subnets                    = var.public_subnet_ids
  idle_timeout               = 300
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection_enabled
  tags                       = local.common_tags
}

resource "aws_acm_certificate" "public" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = merge(local.common_tags, { Name = local.name_prefix })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.public.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "public" {
  certificate_arn         = aws_acm_certificate.public.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_lb_target_group" "service" {
  name_prefix          = "strgw-"
  port                 = local.container_port
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
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

# A load balancer change replaces the listener, deleting the old one first, so the target group is
# never attached to two load balancers.
resource "aws_lb_listener" "https" {
  load_balancer_arn = local.uses_shared_load_balancer ? var.shared_load_balancer.arn : aws_lb.public[0].arn
  port              = local.uses_shared_load_balancer ? local.shared_listener_port : 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service.arn
  }

  tags = local.common_tags
}

resource "aws_route53_record" "public" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    evaluate_target_health = !local.uses_shared_load_balancer
    name                   = local.uses_shared_load_balancer ? aws_cloudfront_distribution.edge[0].domain_name : aws_lb.public[0].dns_name
    zone_id                = local.uses_shared_load_balancer ? aws_cloudfront_distribution.edge[0].hosted_zone_id : aws_lb.public[0].zone_id
  }
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

# IAM names use the `agent-` workload prefix the deployment role may create (bootstrap/dev).
resource "aws_iam_role" "execution" {
  name_prefix          = "agent-${local.name_prefix}-exec-"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name_prefix          = "agent-${local.name_prefix}-task-"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

# Both parameters use the AWS-managed aws/ssm key, which needs no explicit kms:Decrypt grant.
data "aws_iam_policy_document" "task_parameters" {
  statement {
    actions = ["ssm:GetParameter"]
    resources = [
      var.durable_streams_auth_secret_arn,
      var.stream_session_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_parameters" {
  name_prefix = "parameters-"
  role        = aws_iam_role.task.id
  policy      = data.aws_iam_policy_document.task_parameters.json
}

resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_ecs_task_definition" "service" {
  family                   = local.name_prefix
  cpu                      = var.compact_task_sizing_enabled ? "256" : "512"
  memory                   = var.compact_task_sizing_enabled ? "512" : "1024"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = local.container_name
    image       = var.image
    essential   = true
    stopTimeout = 30
    environment = [
      { name = "PORT", value = tostring(local.container_port) },
      { name = "DEPLOYMENTS_AI_DURABLE_STREAMS_URL", value = var.durable_streams_base_url },
      { name = "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN", value = var.durable_streams_auth_secret_arn },
      { name = "DEPLOYMENTS_AI_STREAM_SESSION_SECRET_ARN", value = var.stream_session_secret_arn },
      { name = "DEPLOYMENTS_AI_STREAM_GATEWAY_ALLOWED_ORIGINS", value = join(",", var.allowed_origins) },
    ]
    portMappings = [{
      containerPort = local.container_port
      hostPort      = local.container_port
      protocol      = "tcp"
    }]
    healthCheck = {
      command = [
        "CMD",
        "bun",
        "-e",
        "const r = await fetch('http://127.0.0.1:${local.container_port}/healthz'); process.exit(r.status === 200 ? 0 : 1)",
      ]
      interval    = 30
      retries     = 3
      startPeriod = 15
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

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "service" {
  name                  = local.name_prefix
  cluster               = aws_ecs_cluster.runtime.arn
  task_definition       = aws_ecs_task_definition.service.arn
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
    security_groups  = [aws_security_group.service.id]
    subnets          = var.private_subnet_ids
  }

  load_balancer {
    container_name   = local.container_name
    container_port   = local.container_port
    target_group_arn = aws_lb_target_group.service.arn
  }

  depends_on = [
    aws_ecs_cluster_capacity_providers.runtime,
    aws_iam_role_policy.task_parameters,
    aws_iam_role_policy_attachment.execution,
    aws_lb_listener.https,
  ]
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_errors" {
  alarm_name          = "${local.name_prefix}-target-5xx"
  alarm_description   = "The stream gateway is returning target 5xx responses."
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
    LoadBalancer = local.load_balancer_arn_suffix
    TargetGroup  = aws_lb_target_group.service.arn_suffix
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "healthy_targets" {
  alarm_name          = "${local.name_prefix}-no-healthy-targets"
  alarm_description   = "The stream gateway has no healthy target."
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
    LoadBalancer = local.load_balancer_arn_suffix
    TargetGroup  = aws_lb_target_group.service.arn_suffix
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
