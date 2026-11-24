import { expect, test } from "bun:test";

const bootstrap = await Bun.file(
  new URL(
    "../infrastructure/modules/observability-clickhouse/clickhouse-bootstrap.sh.tftpl",
    import.meta.url,
  ),
).text();
const moduleMain = await Bun.file(
  new URL("../infrastructure/modules/observability-clickhouse/main.tf", import.meta.url),
).text();
const service = await Bun.file(
  new URL("../infrastructure/modules/observability-clickhouse/service.tf", import.meta.url),
).text();
const stackApi = await Bun.file(
  new URL("../infrastructure/modules/platform/identity-and-api.tf", import.meta.url),
).text();
const stackObservability = await Bun.file(
  new URL("../infrastructure/modules/platform/observability.tf", import.meta.url),
).text();
const stackOutputs = await Bun.file(
  new URL("../infrastructure/modules/platform/outputs.tf", import.meta.url),
).text();
const backups = await Bun.file(
  new URL(
    "../infrastructure/modules/observability-clickhouse/backup-and-alarms.tf",
    import.meta.url,
  ),
).text();
const compute = await Bun.file(
  new URL("../infrastructure/modules/observability-clickhouse/compute.tf", import.meta.url),
).text();
const dockerignore = await Bun.file(new URL("../.dockerignore", import.meta.url)).text();
const hotPlaneDockerfile = await Bun.file(
  new URL("../apps/observability-hot-plane/Dockerfile", import.meta.url),
).text();
const imageInstaller = await Bun.file(
  new URL("../infrastructure/images/clickhouse/install-clickhouse.sh", import.meta.url),
).text();
const moduleVariables = await Bun.file(
  new URL("../infrastructure/modules/observability-clickhouse/variables.tf", import.meta.url),
).text();
const coldQueries = await Bun.file(
  new URL("../infrastructure/modules/agent-observability/queries.tf", import.meta.url),
).text();
const coldModule = await Bun.file(
  new URL("../infrastructure/modules/agent-observability/main.tf", import.meta.url),
).text();
const coldDelivery = await Bun.file(
  new URL("../infrastructure/modules/agent-observability/delivery.tf", import.meta.url),
).text();
const apiRuntime = await Bun.file(
  new URL("../infrastructure/modules/platform-api/governance-runtime.tf", import.meta.url),
).text();
const apiLambda = await Bun.file(
  new URL("../functions/api/src/observability-api-main.ts", import.meta.url),
).text();

test("declares ClickHouse service-user grants in the XML user store", () => {
  expect(bootstrap).toContain("<query>GRANT SELECT ON observability.*</query>");
  expect(bootstrap).not.toContain("TO observability_ingest");
  expect(bootstrap).not.toContain("<access_management>1</access_management>");
  expect(bootstrap).toContain("<max_memory_usage>268435456</max_memory_usage>");
});

test("bakes ClickHouse without interactive package prompts", () => {
  expect(imageInstaller).toContain("DEBIAN_FRONTEND=noninteractive");
  expect(imageInstaller).toContain("CLICKHOUSE_PASSWORD=''");
});

test("rejects burstable nodes smaller than the supported t4g.small floor", () => {
  expect(moduleVariables).toContain("t4g\\\\.(small|medium|large|xlarge|2xlarge)");
  expect(moduleVariables).not.toContain('"^(t4g|r7g)');
  expect(bootstrap).toContain("<timezone>UTC</timezone>");
});

test("isolates public service auth from ClickHouse database credentials", () => {
  expect(moduleMain).toContain('resource "aws_ssm_parameter" "service"');
  expect(service).toContain("valueFrom = aws_ssm_parameter.service.arn");
  expect(stackApi).toContain(
    'observability_secret_arn                   = try(module.agent_observability_hot[0].service_secret_arn, "")',
  );
});

test("runs scheduled backup payloads with an explicit Bash interpreter", () => {
  expect(backups).toContain("<<'OBSERVABILITY_BACKUP'");
  expect(backups).toContain("mktemp /run/agent-observability-backup.XXXXXX");
  expect(backups).toContain("aws ec2 wait snapshot-completed");
  expect(backups).toContain('[[ \\"$snapshot_state\\" == \\"completed\\" ]]');
  expect(backups).toContain('/usr/bin/env bash \\"$script_path\\"; status=$?;');
  expect(backups).not.toContain("/tmp/agent-observability-backup.sh");
});

test("includes the hot-plane application in the restricted Docker build context", () => {
  expect(dockerignore).toContain("!apps/observability-hot-plane/**");
  expect(dockerignore).toContain("!apps/*/package.json");
  expect(dockerignore).not.toContain("!patches/**");
  expect(hotPlaneDockerfile).not.toContain("COPY patches ./patches");
  expect(hotPlaneDockerfile).toContain("COPY apps ./apps");
  expect(hotPlaneDockerfile).toContain("COPY functions ./functions");
  expect(hotPlaneDockerfile).toContain("COPY packages ./packages");
  expect(hotPlaneDockerfile).toContain(
    "/workspace/apps/observability-hot-plane/node_modules ./apps/observability-hot-plane/node_modules",
  );
  expect(hotPlaneDockerfile).toContain(
    "/workspace/packages/db/node_modules ./packages/db/node_modules",
  );
  expect(hotPlaneDockerfile).toContain(
    "/workspace/packages/observability/node_modules ./packages/observability/node_modules",
  );
  expect(hotPlaneDockerfile).toContain("COPY packages/db/package.json ./packages/db/package.json");
});

test("registers ClickHouse through its Cloud Map-managed namespace", () => {
  expect(compute).toContain('resource "aws_service_discovery_service" "node"');
  expect(compute).toContain('resource "aws_service_discovery_instance" "node"');
  expect(compute).toContain("AWS_INSTANCE_IPV4 = aws_instance.node.private_ip");
  expect(compute).not.toContain("health_check_custom_config");
  expect(compute).not.toContain('resource "aws_route53_record" "node"');
  expect(service).not.toContain("health_check_custom_config");
  expect(service).toMatch(/depends_on\s*=\s*\[[^\]]*aws_service_discovery_instance\.node[^\]]*\]/u);
});

test("uses EC2 role credentials for immutable rebuild exports", () => {
  expect(bootstrap).toContain("<observability_rebuild>");
  expect(bootstrap).toContain(
    "<url>https://${backup_bucket}.s3.${aws_region}.amazonaws.com/rebuild/</url>",
  );
});

test("writes native backups directly to independently addressable S3 paths", () => {
  expect(backups).toContain(
    "BACKUP DATABASE observability TO S3('https://${aws_s3_bucket.backups.id}.s3.${data.aws_region.current.region}.amazonaws.com/native/$backup_name')",
  );
  expect(backups).not.toContain("TO Disk('backups'");
  expect(bootstrap).not.toContain("<allowed_disk>backups</allowed_disk>");
});

test("limits automated snapshot deletion to this backup job and volume", () => {
  expect(backups).toContain("Name=tag:ManagedBy,Values=ssm-backup");
  expect(backups).toContain("Name=tag:SourceVolumeId,Values=${local.data_volume_id}");
  expect(backups).toContain("Name=volume-id,Values=${local.data_volume_id}");
  expect(backups).toContain('cutoff_epoch=$(date -u -d \\"$retention_days days ago\\" +%s)');
  expect(backups).toContain("if (( start_epoch < cutoff_epoch )); then");
  expect(backups).not.toContain("sort_by(@, &StartTime)");
  expect(compute).toContain('variable = "ec2:ResourceTag/ManagedBy"');
  expect(compute).toContain('variable = "ec2:ResourceTag/SourceVolumeId"');
  expect(compute).toContain('variable = "ec2:CreateAction"');
  expect(compute).toContain('values   = ["CreateSnapshot"]');
  expect(compute).not.toContain('actions = ["ec2:CreateSnapshot", "ec2:CreateTags"]');
});

test("fails closed instead of reformatting an unrecognized data volume", () => {
  expect(bootstrap).toContain('filesystem_state="$(aws ec2 describe-volumes');
  expect(bootstrap).toContain(
    '[[ "$${filesystem_state}" != "uninitialized" || -n "$${signatures}" ]]',
  );
  expect(bootstrap).toContain("Key=FilesystemState,Value=formatting");
  expect(bootstrap).toContain("Key=FilesystemState,Value=initialized");
  expect(bootstrap).toContain('mkfs.xfs "$${device}"');
  expect(bootstrap).not.toContain("mkfs.xfs -f");
  expect(compute).toContain('FilesystemState = "uninitialized"');
  expect(compute).toContain('ignore_changes  = [tags["FilesystemState"]]');
});

test("enables EC2 API termination protection when deletion protection is required", () => {
  expect(compute).toContain("disable_api_termination     = var.deletion_protection_enabled");
  expect(compute).toContain("force_destroy               = var.deletion_protection_enabled");
  expect(compute).toContain("stop_instance_before_detaching = true");
});

test("keeps hot-writer quarantine records tenant-neutral", () => {
  expect(service).toContain('actions   = ["s3:PutObject"]');
  expect(service).toContain("${var.quarantine_bucket_arn}/hot-writer/*");
  expect(stackObservability).toContain(
    "quarantine_bucket_name      = module.agent_observability[0].quarantine_bucket_name",
  );
});

test("rolls ClickHouse consumers when TLS parameter versions renew", () => {
  expect(moduleMain).toContain("early_renewal_hours   = 720");
  expect(compute).toContain("runtime_parameter_versions");
  expect(service).toContain("OBSERVABILITY_CREDENTIAL_GENERATION");
  expect(bootstrap).toContain("Runtime parameter versions: ${runtime_parameter_versions}");
});

test("bounds cold rebuild scans to the hot retention windows", () => {
  expect(coldQueries.match(/interval '30' day/gu)).toHaveLength(3);
  expect(coldQueries.match(/interval '90' day/gu)).toHaveLength(3);
  expect(coldQueries).toContain('resource "aws_athena_named_query" "clickhouse_rebuild_export"');
  expect(coldQueries).toContain("-- SPANS_RETENTION_FILTER");
  expect(coldQueries).toContain("WHERE fact_type != 'projection.checkpoint'");
  expect(coldQueries).toContain('name        = "agent_observability_rebuild_export"');
  expect(
    coldQueries.match(/WHERE fact_type != 'projection\.checkpoint'/gu)?.length,
  ).toBeGreaterThanOrEqual(13);
});

test("persists projector ingestion checkpoints without treating them as commits", () => {
  expect(coldModule).toContain('resource "aws_dynamodb_table" "projector_checkpoints"');
  expect(coldModule).toContain("DEPLOYMENTS_AI_OBSERVABILITY_PROJECTOR_CHECKPOINT_TABLE");
  expect(coldModule).toContain('actions   = ["dynamodb:PutItem"]');
  expect(coldQueries).not.toContain('resource "aws_athena_named_query" "projector_commits"');
  expect(coldDelivery).toContain("retry_duration     = 300");
  expect(stackOutputs).toContain("module.agent_observability[0].projector_checkpoint_table_name");
  expect(stackOutputs).toContain(
    "module.agent_observability[0].projector_event_source_mapping_uuid",
  );
});

test("pins one service-token parameter version into both ECS and Lambda", () => {
  expect(stackApi).toContain(
    'observability_secret_version_id            = try(module.agent_observability_hot[0].service_secret_version_id, "")',
  );
  expect(apiRuntime).toContain("DEPLOYMENTS_AI_OBSERVABILITY_SECRET_VERSION_ID");
  expect(apiLambda).toContain('parseAwsSecretReference(arn).kind === "secret"');
});

test("uses process liveness for ECS while application readiness waits on ClickHouse", () => {
  expect(service).toContain("fetch('http://127.0.0.1:3000/health')");
});

test("grants the task channels required by ECS Exec", () => {
  expect(service).toContain('"ssmmessages:CreateControlChannel"');
  expect(service).toContain('"ssmmessages:OpenDataChannel"');
});
