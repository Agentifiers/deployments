/**
 * Starts ClickHouse in Docker the way the dev node runs it: the version pinned in
 * clickhouse-packages.json, the server and user XML the module's bootstrap template writes, TLS on
 * 8443, and the t4g.medium's 2 vCPUs, 4 GiB, and gp3 data-volume IO limits.
 *
 *   bun apps/observability-hot-plane/bench/clickhouse.ts start|stop
 *   bun apps/observability-hot-plane/bench/clickhouse.ts configure [commit]
 *
 * `configure` rewrites the users profile from the template at `commit` (default: this worktree)
 * on the running server, which reloads it without a restart.
 */
import { $ } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BENCH_DIR, BENCH_PASSWORDS, CLICKHOUSE_CONTAINER } from "./settings.ts";

const MODULE = resolve(import.meta.dir, "../../../infrastructure/modules/observability-clickhouse");
const TEMPLATE_PATH =
  "infrastructure/modules/observability-clickhouse/clickhouse-bootstrap.sh.tftpl";
const DOCKER = process.env.BENCH_DOCKER ?? "sudo -n docker";
const CONFIG_DIR = join(BENCH_DIR, "config.d");
const USERS_DIR = join(BENCH_DIR, "users.d");

/** The values compute.tf passes for a default dev install (no explicit server memory cap). */
const TEMPLATE_VALUES: Readonly<Record<string, string>> = {
  aws_region: "us-east-1",
  backup_bucket: "bench-backups",
  client_cidr: "127.0.0.0/8",
  server_memory_bytes: "0",
  server_memory_to_ram_ratio: "0.7",
};

function heredoc(template: string, path: string) {
  const start = template.indexOf(`cat > ${path} <<`);
  if (start < 0) throw new Error(`The bootstrap template no longer writes ${path}.`);
  const body = template.indexOf("\n", start) + 1;
  return template.slice(body, template.indexOf("\nXML\n", body) + 1);
}

/** OpenTofu interpolation, then the shell expansion of the unquoted users heredoc. */
function render(text: string, values: Readonly<Record<string, string>>) {
  return text.replaceAll(/(\$?)\$\{([a-z_]+)\}/gu, (match, escaped: string, name: string) => {
    if (escaped) return match.slice(1);
    const value = values[name];
    if (value === undefined) throw new Error(`No bench value for template variable ${name}.`);
    return value;
  });
}

async function template(ref: string | undefined) {
  if (!ref) return readFileSync(join(MODULE, "clickhouse-bootstrap.sh.tftpl"), "utf8");
  return $`git -C ${MODULE} show ${`${ref}:${TEMPLATE_PATH}`}`.text();
}

function writeUsers(text: string) {
  const users = render(
    heredoc(text, "/etc/clickhouse-server/users.d/observability.xml"),
    TEMPLATE_VALUES,
  );
  writeFileSync(join(USERS_DIR, "observability.xml"), render(users, BENCH_PASSWORDS));
}

const client = (user: string, password: string, query: string) =>
  $`sh -c ${`${DOCKER} exec ${CLICKHOUSE_CONTAINER} clickhouse-client --user ${user} --password ${password} --query "${query}"`}`
    .quiet()
    .nothrow();

async function certificates(directory: string) {
  mkdirSync(directory, { recursive: true });
  await $`openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=bench-ca -keyout ${directory}/ca-key.pem -out ${directory}/ca.pem`.quiet();
  await $`openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout ${directory}/server-key.pem -out ${directory}/server.csr`.quiet();
  writeFileSync(join(directory, "san.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  await $`openssl x509 -req -in ${directory}/server.csr -CA ${directory}/ca.pem -CAkey ${directory}/ca-key.pem -CAcreateserial -days 7 -extfile ${directory}/san.cnf -out ${directory}/server.pem`.quiet();
  await $`chmod 0644 ${directory}/ca.pem ${directory}/server.pem ${directory}/server-key.pem`;
}

async function configure(ref: string | undefined) {
  const text = await template(ref);
  writeUsers(text);
  const expected = /<max_concurrent_queries_for_user>(\d+)</u.exec(text)?.[1] ?? "0";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await client(
      "observability_query",
      BENCH_PASSWORDS.query_password,
      "SELECT getSetting('max_concurrent_queries_for_user')",
    );
    if (current.stdout.toString().trim() === expected) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`ClickHouse did not reload the users profile of ${ref ?? "the worktree"}.`);
}

async function start() {
  const text = await template(undefined);
  const { version } = JSON.parse(
    readFileSync(join(MODULE, "clickhouse-packages.json"), "utf8"),
  ) as { readonly version: string };
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(USERS_DIR, { recursive: true });
  await certificates(join(BENCH_DIR, "certs"));
  writeFileSync(
    join(CONFIG_DIR, "observability.xml"),
    render(heredoc(text, "/etc/clickhouse-server/config.d/observability.xml"), TEMPLATE_VALUES),
  );
  writeUsers(text);
  const device = (await $`findmnt -no SOURCE --target /var/lib/docker`.text()).trim();
  await $`sh -c ${`${DOCKER} rm -f ${CLICKHOUSE_CONTAINER} >/dev/null 2>&1; ${DOCKER} volume rm -f ${CLICKHOUSE_CONTAINER}-data >/dev/null 2>&1; true`}`;
  await $`sh -c ${[
    `${DOCKER} run -d --name ${CLICKHOUSE_CONTAINER} --network host`,
    "--cpus 2 --memory 4g --memory-swap 4g --ulimit nofile=262144:262144",
    `--device-read-bps ${device}:125mb --device-write-bps ${device}:125mb`,
    `--device-read-iops ${device}:3000 --device-write-iops ${device}:3000`,
    "-e CLICKHOUSE_SKIP_USER_SETUP=1",
    `-v ${CLICKHOUSE_CONTAINER}-data:/var/lib/clickhouse`,
    `-v ${CONFIG_DIR}/observability.xml:/etc/clickhouse-server/config.d/observability.xml:ro`,
    `-v ${USERS_DIR}:/etc/clickhouse-server/users.d:ro`,
    `-v ${BENCH_DIR}/certs:/etc/clickhouse-server/certs:ro`,
    `clickhouse/clickhouse-server:${version}`,
  ].join(" ")}`.quiet();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await client("default", BENCH_PASSWORDS.admin_password, "SELECT 1")).exitCode === 0) {
      await client(
        "default",
        BENCH_PASSWORDS.admin_password,
        "CREATE DATABASE IF NOT EXISTS observability",
      );
      console.log(`ClickHouse ${version} is ready on https://localhost:8443.`);
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error("ClickHouse did not become ready within 60 seconds.");
}

async function stop() {
  await $`sh -c ${`${DOCKER} rm -f ${CLICKHOUSE_CONTAINER}; ${DOCKER} volume rm -f ${CLICKHOUSE_CONTAINER}-data`}`.nothrow();
}

const [command, ref] = process.argv.slice(2);
if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "configure") await configure(ref);
else throw new Error("Usage: clickhouse.ts start|stop|configure [commit]");
