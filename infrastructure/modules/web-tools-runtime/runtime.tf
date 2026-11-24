locals {
  runtime_log_configuration = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.runtime.name
      awslogs-region        = data.aws_region.current.region
      awslogs-stream-prefix = "ecs"
    }
  }

  egress_proxy_container = {
    name              = "web-egress-proxy"
    image             = var.proxy_image
    essential         = true
    cpu               = var.compact_task_sizing_enabled ? 32 : 128
    memoryReservation = var.compact_task_sizing_enabled ? 128 : 256
    entryPoint        = ["bun", "-e"]
    command           = [local.proxy_command]
    environment = [
      { name = "MODEL_GATEWAY_BASE_URL", value = var.model_gateway_base_url },
      { name = "MODEL_GATEWAY_TOKEN_ISSUER", value = var.model_gateway_token_issuer.function_name },
    ]
    secrets      = []
    mountPoints  = []
    portMappings = []
    healthCheck = {
      command = [
        "CMD-SHELL",
        "bun -e \"import net from 'node:net'; let ready=0; for (const port of [3335,3336]) { const socket=net.connect(port,'127.0.0.1',()=>{socket.end(); if (++ready===2) process.exit(0)}); socket.on('error',()=>process.exit(1)); }\"",
      ]
      interval    = 15
      retries     = 5
      startPeriod = 10
      timeout     = 5
    }
    stopTimeout = 30
    logConfiguration = merge(local.runtime_log_configuration, {
      options = merge(local.runtime_log_configuration.options, { awslogs-stream-prefix = "egress-proxy" })
    })
  }

  searxng_container = {
    name              = "searxng"
    image             = var.searxng_image
    essential         = true
    cpu               = var.compact_task_sizing_enabled ? 32 : 128
    memoryReservation = var.compact_task_sizing_enabled ? 128 : 256
    entryPoint        = ["/bin/sh", "-c"]
    command           = [local.searxng_command]
    environment       = []
    secrets = [{
      name      = "SEARXNG_SECRET"
      valueFrom = aws_ssm_parameter.runtime["firecrawl-searxng-secret"].arn
    }]
    mountPoints  = []
    portMappings = []
    dependsOn = [{
      containerName = "web-egress-proxy"
      condition     = "HEALTHY"
    }]
    stopTimeout = 30
    logConfiguration = merge(local.runtime_log_configuration, {
      options = merge(local.runtime_log_configuration.options, { awslogs-stream-prefix = "searxng" })
    })
  }

  # Default renderer: Lightpanda serves CDP on loopback only and fetches every page through
  # the deny-private proxy. A crash restarts this container in place instead of the task.
  lightpanda_container = {
    name              = "lightpanda"
    image             = var.lightpanda_image
    essential         = true
    cpu               = var.compact_task_sizing_enabled ? 128 : 512
    memoryReservation = var.compact_task_sizing_enabled ? 512 : 768
    command = [
      "/bin/lightpanda", "serve",
      "--host", "127.0.0.1",
      "--port", "9222",
      "--http-proxy", "http://127.0.0.1:3335",
      "--log-level", "warn",
    ]
    environment = [
      { name = "LIGHTPANDA_DISABLE_TELEMETRY", value = "true" },
    ]
    secrets      = []
    mountPoints  = []
    portMappings = []
    dependsOn = [{
      containerName = "web-egress-proxy"
      condition     = "HEALTHY"
    }]
    # The image has bash but no curl, wget, or nc.
    healthCheck = {
      command     = ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9222"]
      interval    = 15
      retries     = 5
      startPeriod = 10
      timeout     = 5
    }
    restartPolicy = {
      enabled              = true
      restartAttemptPeriod = 60
    }
    stopTimeout = 30
    logConfiguration = merge(local.runtime_log_configuration, {
      options = merge(local.runtime_log_configuration.options, { awslogs-stream-prefix = "lightpanda" })
    })
  }

  firecrawl_container = {
    name              = "firecrawl"
    image             = var.firecrawl_image
    essential         = true
    cpu               = var.compact_task_sizing_enabled ? 256 : 1024
    memoryReservation = var.compact_task_sizing_enabled ? 1280 : 2048
    command           = ["node", "dist/src/harness.js", "--start-docker"]
    environment = [
      { name = "AWS_REGION", value = data.aws_region.current.region },
      { name = "CRAWL_CONCURRENT_REQUESTS", value = "1" },
      { name = "ENV", value = "local" },
      { name = "FIRECRAWL_DYNAMODB_TABLE", value = aws_dynamodb_table.firecrawl.name },
      { name = "HOST", value = "0.0.0.0" },
      { name = "LIGHTPANDA_CDP_URL", value = "ws://127.0.0.1:9222" },
      { name = "LOGGING_LEVEL", value = "warn" },
      { name = "MAX_CONCURRENT_JOBS", value = "1" },
      { name = "MODEL_EMBEDDING_NAME", value = var.firecrawl_embedding_model_name },
      { name = "MODEL_NAME", value = var.firecrawl_model_name },
      { name = "NUM_WORKERS_PER_QUEUE", value = "1" },
      { name = "NUQ_WORKER_COUNT", value = "1" },
      # Firecrawl requires a key; the proxy sidecar discards it and sends a web-tools gateway token.
      { name = "OPENAI_API_KEY", value = "unused-model-gateway-proxy" },
      { name = "OPENAI_BASE_URL", value = "http://127.0.0.1:3336" },
      # Chromium fallback renderer service, resolved through Cloud Map.
      { name = "PLAYWRIGHT_MICROSERVICE_URL", value = "http://${local.chromium_dns_name}:3000/scrape" },
      { name = "PORT", value = "3002" },
      { name = "PROXY_SERVER", value = "http://127.0.0.1:3335" },
      { name = "SEARXNG_ENDPOINT", value = "http://127.0.0.1:8080" },
      { name = "USE_DB_AUTHENTICATION", value = "false" },
    ]
    secrets     = []
    mountPoints = []
    portMappings = [{
      containerPort = 3002
      hostPort      = 3002
      protocol      = "tcp"
    }]
    dependsOn = [
      { containerName = "lightpanda", condition = "HEALTHY" },
      { containerName = "searxng", condition = "START" },
      { containerName = "web-egress-proxy", condition = "HEALTHY" },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3002/v0/health/liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      retries     = 5
      startPeriod = 120
      timeout     = 10
    }
    stopTimeout = 120
    logConfiguration = merge(local.runtime_log_configuration, {
      options = merge(local.runtime_log_configuration.options, { awslogs-stream-prefix = "firecrawl" })
    })
  }
}

resource "aws_ecs_task_definition" "firecrawl" {
  family = local.name_prefix
  # Container CPU reservations keep a 1:1:4:8 proxy/SearXNG/Playwright/Firecrawl ratio and
  # sum below the task size; containers share any unreserved CPU.
  cpu                      = var.compact_task_sizing_enabled ? "512" : "2048"
  memory                   = var.compact_task_sizing_enabled ? "3072" : "4096"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([
    local.egress_proxy_container,
    local.searxng_container,
    local.lightpanda_container,
    local.firecrawl_container,
  ])

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "firecrawl" {
  name                  = local.name_prefix
  cluster               = var.ecs_cluster_arn
  task_definition       = aws_ecs_task_definition.firecrawl.arn
  desired_count         = var.desired_count
  wait_for_steady_state = true
  # The provider requires a forced rollout for capacity provider strategy changes.
  force_new_deployment = true

  capacity_provider_strategy {
    capacity_provider = var.fargate_spot_enabled ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  # Tasks share the DynamoDB queue, so a replacement task starts before the old one drains.
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups = [
      aws_security_group.service.id,
      aws_security_group.public_http.id,
      aws_security_group.public_https.id,
    ]
    subnets = var.private_subnet_ids
  }

  load_balancer {
    container_name   = "firecrawl"
    container_port   = 3002
    target_group_arn = aws_lb_target_group.firecrawl.arn
  }

  depends_on = [aws_lb_listener.firecrawl]

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "healthy_targets" {
  count = var.alarms_enabled && var.desired_count > 0 ? 1 : 0

  alarm_name          = "web-tools-no-healthy-targets"
  alarm_description   = "Firecrawl has no healthy load balancer target while the service is enabled."
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
    LoadBalancer = data.aws_lb.runtime.arn_suffix
    TargetGroup  = aws_lb_target_group.firecrawl.arn_suffix
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  count = var.alarms_enabled && var.desired_count > 0 ? 1 : 0

  alarm_name          = "web-tools-unhealthy-targets"
  alarm_description   = "Firecrawl has an unhealthy load balancer target."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    LoadBalancer = data.aws_lb.runtime.arn_suffix
    TargetGroup  = aws_lb_target_group.firecrawl.arn_suffix
  }

  tags = local.common_tags
}
