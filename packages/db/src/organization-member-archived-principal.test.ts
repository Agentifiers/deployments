import { describe, expect, spyOn, test } from "bun:test";
import {
  key,
  makeDynamoDatabase,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type PersistenceIdentity,
  type PersistenceInvocation,
} from "./index.ts";
import { humanPrincipalRecord } from "./tenancy-test-support.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";

const FOUNDER = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const JOINER = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const JOINER_EMAIL = "joiner@example.com";
const founder: PersistenceIdentity = { principalId: FOUNDER, scopes: ["platform:*"] };
let sequence = 0;

function invocation<Body>(
  body: Body,
  identity: PersistenceIdentity,
  options: { readonly id?: string; readonly organizationId?: string } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity,
    idempotencyKey: `archived-principal-${++sequence}`,
    ...(options.id ? { id: options.id } : {}),
    query: {},
    scope: options.organizationId ? { organizationId: options.organizationId } : {},
  };
}

/**
 * An organization, and a joiner whose account `arm()` arranges to be deleted, which archives the
 * principal, right after the next membership write reads the principal as active.
 */
async function joiningOrganization() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  const joiner = humanPrincipalRecord(JOINER, JOINER_EMAIL);
  fake.put(tables.control, humanPrincipalRecord(FOUNDER, "founder@example.com"));
  fake.put(tables.control, joiner);
  const service = makeTenancyPersistence({
    database: makeDynamoDatabase(fake.client, tables),
    generateInvitationToken: (invitationId) => `invite-${invitationId}-secret`,
  });
  const { id: organizationId } = await service.organizations.create(
    invocation({ name: "Joiners" }, founder),
  );
  const arm = () => {
    const send = fake.client.send.bind(fake.client);
    const deletion = spyOn(fake.client, "send").mockImplementation((async (
      command: Parameters<typeof send>[0],
    ) => {
      const result = await send(command);
      if ((command.input as { Key?: { pk?: string } }).Key?.pk === key("PRINCIPAL", JOINER)) {
        deletion.mockRestore();
        const { primaryEmail: _primaryEmail, ...kept } = joiner.data;
        fake.put(
          tables.control,
          withCanonicalRecordKeys({
            ...joiner,
            data: { ...kept, status: "archived", version: joiner.data.version + 1 },
          }),
        );
      }
      return result;
    }) as typeof send);
    return deletion;
  };
  const membership = () =>
    (
      fake.get(tables.control, {
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-MEMBER", JOINER),
      })?.data as { status?: string } | undefined
    )?.status;
  return { arm, membership, organizationId, service };
}

const outcome = (call: Promise<unknown>) =>
  call.then(
    () => "joined",
    (error: { code?: string }) => error.code ?? "failed",
  );

describe("a principal archived while joining an organization", () => {
  test("is not added as a member", async () => {
    const { arm, membership, organizationId, service } = await joiningOrganization();
    const deletion = arm();

    const added = await outcome(
      service.organizationMembers.add(
        invocation({ principalId: JOINER, role: "member" }, founder, { organizationId }),
      ),
    ).finally(() => deletion.mockRestore());

    expect({ added, membership: membership() }).toEqual({
      added: "member_conflict",
      membership: undefined,
    });
  });

  test("cannot accept an invitation", async () => {
    const { arm, membership, organizationId, service } = await joiningOrganization();
    const invitation = await service.organizationInvitations.create(
      invocation({ email: JOINER_EMAIL, role: "member" }, founder, { organizationId }),
    );
    const deletion = arm();

    const accepted = await outcome(
      service.organizationInvitations.accept(
        invocation(
          { token: invitation.token },
          { principalId: JOINER, scopes: ["invitations:accept"] },
          { id: invitation.id },
        ),
      ),
    ).finally(() => deletion.mockRestore());

    expect({ accepted, membership: membership() }).toEqual({
      accepted: "invitation_conflict",
      membership: undefined,
    });
  });
});
