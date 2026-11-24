import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
import { appDatabaseNames, type AppDatabaseNames, type AppId, type AppSlug } from "../names.ts";
import { ExportId } from "../protocol.ts";
import {
  asRole,
  asSuperuser,
  createTestControl,
  eraseInput,
  errorOf,
  newAppId,
  newSlug,
  prepareCluster,
  testConnections,
  type TestControl,
} from "./harness.ts";

let harness: TestControl;
let gateway: AppApiGateway;
const apps: Array<{ appId: AppId; slug: AppSlug; names: AppDatabaseNames }> = [];

function app(index: number) {
  const entry = apps[index];
  if (entry === undefined) throw new Error(`App ${index} was not provisioned.`);
  return entry;
}

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  gateway = createAppApiGateway({ connections: testConnections });
  for (let index = 0; index < 2; index += 1) {
    const appId = newAppId();
    const slug = newSlug();
    await harness.control.provision({ appId, slug });
    apps.push({ appId, names: appDatabaseNames(appId), slug });
  }
  await harness.control.migrate({
    appId: app(1).appId,
    description: "secret",
    idempotencyKey: "secret",
    sql: "CREATE TABLE secrets (value text); INSERT INTO secrets VALUES ('B-SECRET');",
  });
});

afterAll(async () => {
  await gateway.close();
  for (const entry of apps) await harness.control.erase(eraseInput(entry));
  await harness.control.close();
});

async function clusterStateOf(names: AppDatabaseNames) {
  return asSuperuser("postgres", async (client) => {
    const acl = await client.query(
      "SELECT datacl::text AS acl FROM pg_database WHERE datname = $1",
      [names.database],
    );
    const memberships = await client.query(
      `SELECT format('%s in %s admin=%s inherit=%s set=%s', member.rolname, granted.rolname,
         m.admin_option::text, m.inherit_option::text, m.set_option::text) AS grant
       FROM pg_auth_members m
       JOIN pg_roles member ON member.oid = m.member
       JOIN pg_roles granted ON granted.oid = m.roleid
       WHERE member.rolname LIKE $1 OR granted.rolname LIKE $1
       ORDER BY 1`,
      [`${names.database}\\_%`],
    );
    return { acl: acl.rows, memberships: memberships.rows.map((row) => String(row.grant)) };
  });
}

describe("database-per-app isolation", () => {
  test("another app's roles cannot connect to an app database", async () => {
    const a = app(0).names;
    const b = app(1).names;
    const attempts = await Promise.all(
      [a.roles.owner, a.roles.editor, a.roles.viewer, a.roles.visitor].map(async (role) => {
        const failure = await errorOf(
          asRole(b.database, role, (client) => client.query("SELECT 1")),
        );
        return `${role}: ${String(failure.code)} ${failure.message}`;
      }),
    );
    expect(attempts).toEqual([
      `${a.roles.owner}: 42501 permission denied for database "${b.database}"`,
      `${a.roles.editor}: 42501 permission denied for database "${b.database}"`,
      `${a.roles.viewer}: 42501 permission denied for database "${b.database}"`,
      `${a.roles.visitor}: 42501 permission denied for database "${b.database}"`,
    ]);
  });

  test("set_config('role', ...) is denied inside a plpgsql function and a column DEFAULT", async () => {
    const a = app(0);
    const b = app(1).names;
    await harness.control.migrate({
      appId: a.appId,
      description: "escape attempts",
      idempotencyKey: "escape",
      sql: `
CREATE FUNCTION public.escape() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', '${b.roles.owner}', true);
  RETURN (SELECT value FROM secrets LIMIT 1);
END $$;
CREATE TABLE notes (
  body text,
  actor text DEFAULT set_config('role', '${b.roles.editor}', true)
);
CREATE FUNCTION api.add_note(p_body text) RETURNS void LANGUAGE sql VOLATILE
  BEGIN ATOMIC INSERT INTO notes (body) VALUES (p_body); END;`,
    });

    const viaFunction = await errorOf(
      harness.control.query({ appId: a.appId, maxRows: 1, sql: "SELECT public.escape()" }),
    );
    const viaDefault = await errorOf(
      gateway.callApiFunction({
        appId: a.appId,
        appIsPublic: false,
        args: { p_body: "hello" },
        functionName: "add_note",
        principal: { email: "member@example.com", id: "principal-1" },
        role: "editor",
      }),
    );

    expect([viaFunction, viaDefault]).toEqual([
      {
        code: "postgres_error",
        message: `permission denied to set role "${b.roles.owner}"`,
        name: "AppDatabaseError",
        statement: "SELECT public.escape()",
      },
      {
        code: "postgres_error",
        message: `permission denied to set role "${b.roles.editor}"`,
        name: "AppDatabaseError",
        statement: "api.add_note",
      },
    ]);
  });

  test("a trojan view and an RLS policy function gain nothing during describe and export", async () => {
    const a = app(0);
    const b = app(1).names;
    const before = await clusterStateOf(b);
    await harness.control.migrate({
      appId: a.appId,
      description: "trojans",
      idempotencyKey: "trojans",
      sql: `
CREATE FUNCTION public.trojan() RETURNS text LANGUAGE plpgsql AS $$
DECLARE outcome text;
BEGIN
  BEGIN
    PERFORM set_config('role', '${b.roles.owner}', true);
    outcome := 'switched';
  EXCEPTION WHEN OTHERS THEN
    outcome := SQLERRM;
  END;
  BEGIN
    EXECUTE 'GRANT ${b.roles.owner} TO ${a.names.roles.editor}';
  EXCEPTION WHEN OTHERS THEN
    outcome := outcome || '; ' || SQLERRM;
  END;
  RETURN format('%s/%s: %s', session_user, current_user, outcome);
END $$;
CREATE VIEW trojan_view AS SELECT public.trojan() AS report;
CREATE TABLE ledger (id int, note text);
INSERT INTO ledger VALUES (1, 'kept');
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY trojan_policy ON ledger USING (public.trojan() IS NOT NULL);`,
    });

    const description = await harness.control.describe(a.appId);
    const ledger = description.relations.find((relation) => relation.name === "ledger");
    const view = description.relations.find((relation) => relation.name === "trojan_view");
    expect({
      policies: ledger?.policies,
      rowSecurity: ledger?.rowSecurity,
      view: view?.definition,
    }).toEqual({
      policies: [
        {
          command: "all",
          name: "trojan_policy",
          permissive: true,
          roles: ["PUBLIC"],
          using: "(public.trojan() IS NOT NULL)",
          withCheck: null,
        },
      ],
      rowSecurity: { enabled: true, forced: false },
      view: " SELECT public.trojan() AS report;",
    });
    const direct = await harness.control.query({
      appId: a.appId,
      maxRows: 1,
      sql: "SELECT report FROM trojan_view",
    });
    expect(direct.rows).toEqual([
      [
        `${a.names.roles.viewer}/${a.names.roles.viewer}: permission denied to set role "${b.roles.owner}"; cannot execute GRANT ROLE in a read-only transaction`,
      ],
    ]);
    expect(before.memberships).toEqual([
      `${b.roles.editor} in rds_iam admin=false inherit=true set=true`,
      `${b.roles.owner} in rds_iam admin=false inherit=true set=true`,
      `${b.roles.viewer} in rds_iam admin=false inherit=true set=true`,
      `${b.roles.visitor} in rds_iam admin=false inherit=true set=true`,
      `platform_provisioner in ${b.roles.editor} admin=false inherit=false set=true`,
      `platform_provisioner in ${b.roles.editor} admin=true inherit=false set=false`,
      `platform_provisioner in ${b.roles.owner} admin=false inherit=false set=true`,
      `platform_provisioner in ${b.roles.owner} admin=true inherit=false set=false`,
      `platform_provisioner in ${b.roles.viewer} admin=false inherit=false set=true`,
      `platform_provisioner in ${b.roles.viewer} admin=true inherit=false set=false`,
      `platform_provisioner in ${b.roles.visitor} admin=false inherit=false set=true`,
      `platform_provisioner in ${b.roles.visitor} admin=true inherit=false set=false`,
    ]);
    const exported = await harness.control.exportTables({
      appId: a.appId,
      bucket: "apps",
      exportId: Schema.decodeUnknownSync(ExportId)("01J9Z3NDEKTSV4RRFFQ69G5FAW"),
    });
    const prefix = `apps/${a.appId}/exports/01J9Z3NDEKTSV4RRFFQ69G5FAW`;
    expect(exported).toEqual({
      objects: [
        { key: `${prefix}/ledger.csv`, rows: 1, table: "ledger" },
        { key: `${prefix}/notes.csv`, rows: 0, table: "notes" },
      ],
    });
    expect(Object.fromEntries(harness.objects.entries)).toEqual({
      [`apps/${prefix}/ledger.csv`]: "id,note\n1,kept\n",
      [`apps/${prefix}/notes.csv`]: "body,actor\n",
    });
    expect(await clusterStateOf(b)).toEqual(before);
  });
});
