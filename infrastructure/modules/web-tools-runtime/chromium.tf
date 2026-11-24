# Chromium fallback renderer: the unmodified Firecrawl Playwright service runs as its own ECS
# service, sized and scaled independently of Firecrawl, which reaches it through Cloud Map.
locals {
  chromium_name     = "${local.name_prefix}-chromium"
  chromium_dns_name = "${aws_service_discovery_service.chromium.name}.${aws_service_discovery_private_dns_namespace.runtime.name}"

  chromium_cpu                  = coalesce(var.chromium_cpu, var.compact_task_sizing_enabled ? 512 : 1024)
  chromium_memory               = coalesce(var.chromium_memory, var.compact_task_sizing_enabled ? 2048 : 4096)
  chromium_max_concurrent_pages = coalesce(var.chromium_max_concurrent_pages, var.compact_task_sizing_enabled ? 1 : 2)

  # Fargate task memory range (MiB) for each supported CPU size.
  fargate_memory_ranges = {
    "256"  = { min = 512, max = 2048 }
    "512"  = { min = 1024, max = 4096 }
    "1024" = { min = 2048, max = 8192 }
    "2048" = { min = 4096, max = 16384 }
    "4096" = { min = 8192, max = 30720 }
  }
  chromium_memory_range = lookup(local.fargate_memory_ranges, tostring(local.chromium_cpu), { min = 1, max = 0 })

  # Browser egress only: this task has no model-gateway proxy, model configuration, or task role.
  browser_proxy_command = <<-EOT
    import { createBrowserEgressProxy } from './packages/web-tools-proxy/src/egress-proxy.ts';
    createBrowserEgressProxy().listen(3335, '127.0.0.1');
  EOT

  chromium_egress_proxy_container = {
    name              = "web-egress-proxy"
    image             = var.proxy_image
    essential         = true
    cpu               = 64
    memoryReservation = 128
    entryPoint        = ["bun", "-e"]
    command           = [local.browser_proxy_command]
    environment       = []
    secrets           = []
    mountPoints       = []
    portMappings      = []
    healthCheck = {
      command = [
        "CMD-SHELL",
        "bun -e \"import net from 'node:net'; const socket=net.connect(3335,'127.0.0.1',()=>{socket.end(); process.exit(0)}); socket.on('error',()=>process.exit(1));\"",
      ]
      interval    = 15
      retries     = 5
      startPeriod = 10
      timeout     = 5
    }
    stopTimeout = 30
    logConfiguration = merge(local.runtime_log_configuration, {
      options = merge(local.runtime_log_configuration.options, { awslogs-stream-prefix = "chromium-egress-proxy" })
    })
  }

  chromium_container = {
    name              = "playwright"
    image             = var.playwright_image
    essential         = true
    cpu               = local.chromium_cpu - 64
    memoryReservation = local.chromium_memory - 128
    environment = [
      { name = "ALLOW_LOCAL_WEBHOOKS", value = "false" },
      { name = "MAX_CONCURRENT_PAGES", value = tostring(local.chromium_max_concurrent_pages) },
      { name = "PORT", value = "3000" },
      { name = "PROXY_SERVER", value = "http://127.0.0.1:3335" },
    ]
    secrets     = []
    mountPoints = []
    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]
    dependsOn = [{
      containerName = "web-egress-proxy"
      condition     = "HEALTHY"
    }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      retries     = 5
      startPeriod = 60
      timeout     = 10
    }
    stopTimeout = 60
    logConfiguration = merge(local.runtime_log_configuration, {
      options = merge(local.runtime_log_configuration.options, { awslogs-stream-prefix = "chromium" })
    })
  }
}

resource "aws_service_discovery_private_dns_namespace" "runtime" {
  name        = "web-tools.internal"
  description = "Private discovery for the web tools runtime"
  vpc         = var.vpc_id
  tags        = local.common_tags
}

resource "aws_service_discovery_service" "chromium" {
  name = "chromium"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.runtime.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "chromium" {
  family                   = local.chromium_name
  cpu                      = tostring(local.chromium_cpu)
  memory                   = tostring(local.chromium_memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([
    local.chromium_egress_proxy_container,
    local.chromium_container,
  ])

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  lifecycle {
    precondition {
      condition = (
        local.chromium_memory >= local.chromium_memory_range.min &&
        local.chromium_memory <= local.chromium_memory_range.max
      )
      error_message = "chromium_memory is not a valid Fargate memory size for chromium_cpu."
    }
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "chromium" {
  name                  = local.chromium_name
  cluster               = var.ecs_cluster_arn
  task_definition       = aws_ecs_task_definition.chromium.arn
  desired_count         = var.chromium_desired_count
  wait_for_steady_state = true
  # The provider requires a forced rollout for capacity provider strategy changes.
  force_new_deployment = true

  capacity_provider_strategy {
    capacity_provider = var.fargate_spot_enabled ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  # A replacement task registers in Cloud Map before the old one drains.
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups = [
      aws_security_group.chromium.id,
      aws_security_group.public_http.id,
      aws_security_group.public_https.id,
    ]
    subnets = var.private_subnet_ids
  }

  service_registries {
    registry_arn = aws_service_discovery_service.chromium.arn
  }

  tags = local.common_tags
}

# No load balancer fronts this service; missing ECS metrics while tasks are desired
# also breach, so the alarm covers both memory pressure and zero running tasks.
resource "aws_cloudwatch_metric_alarm" "chromium_memory" {
  count = var.alarms_enabled && var.chromium_desired_count > 0 ? 1 : 0

  alarm_name          = "${local.chromium_name}-memory"
  alarm_description   = "The Chromium fallback renderer is memory constrained or has no running task."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 90
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    ClusterName = element(split("/", var.ecs_cluster_arn), 1)
    ServiceName = aws_ecs_service.chromium.name
  }

  tags = local.common_tags
}
