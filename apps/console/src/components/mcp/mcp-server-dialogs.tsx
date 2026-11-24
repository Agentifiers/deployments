import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  archiveMcpServerFn,
  createMcpConnectionFn,
  createMcpServerFn,
  discoverMcpServerFn,
  revokeMcpConnectionFn,
  updateMcpServerFn,
} from "../../data/mcp-mutations.ts";
import { invalidateMcpServers } from "../../data/mcp-queries.ts";
import { oneOf } from "../../observability/range.ts";
import {
  createServerBody,
  EMPTY_SERVER_DRAFT,
  endpointUrl,
  readServerDraft,
  serverChanges,
  serverDraft,
  type McpAuthOption,
  type McpConnectionSummary,
  type McpDiscovery,
  type McpServerDraft,
  type McpServerForm,
  type McpServerView,
  type Pinning,
} from "../../mcp/mcp-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  Description,
  ErrorMessage,
  Field,
  Fieldset,
  Label,
  Legend,
  RadioField,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Code } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { PublicId } from "../public-id.tsx";

const AUTH_OPTIONS: Readonly<
  Record<McpAuthOption, { readonly description: string; readonly label: string }>
> = {
  authorization: {
    description: "The whole header value, for schemes other than Bearer, such as Basic.",
    label: "Authorization header",
  },
  bearerToken: {
    description: "The platform sends Authorization: Bearer followed by the token.",
    label: "Bearer token",
  },
  keep: {
    description: "The platform keeps sending the secret it stores for this server.",
    label: "Keep the stored secret",
  },
  none: { description: "The platform calls the endpoint without credentials.", label: "None" },
};

function ServerFields({
  draft,
  form,
  onChange,
}: Readonly<{
  draft: McpServerDraft;
  form: McpServerForm;
  onChange: (draft: McpServerDraft) => void;
}>) {
  const options = form.authChoices.includes(draft.auth)
    ? form.authChoices
    : [draft.auth, ...form.authChoices];
  const secretShown = draft.auth === "bearerToken" || draft.auth === "authorization";
  return (
    <>
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          aria-invalid={draft.name !== "" && !form.name.ok}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          value={draft.name}
        />
        {draft.name !== "" && !form.name.ok ? (
          <ErrorMessage>{form.name.message}</ErrorMessage>
        ) : null}
      </Field>
      <Field>
        <Label>Endpoint</Label>
        <Description>
          The server's Streamable HTTP URL. It must be public and use HTTPS.
        </Description>
        <Input
          autoComplete="off"
          aria-invalid={draft.endpoint !== "" && !form.endpoint.ok}
          onChange={(event) => onChange({ ...draft, endpoint: event.target.value })}
          placeholder="https://mcp.example.com/mcp"
          type="url"
          value={draft.endpoint}
        />
        {draft.endpoint !== "" && !form.endpoint.ok ? (
          <ErrorMessage>{form.endpoint.message}</ErrorMessage>
        ) : null}
      </Field>
      <Field>
        <Label>Tool allowlist</Label>
        <Description>
          One remote tool name per line. The platform discovers and calls only these tools.
        </Description>
        <Textarea
          className="font-mono"
          aria-invalid={draft.toolAllowlist.trim() !== "" && !form.toolAllowlist.ok}
          onChange={(event) => onChange({ ...draft, toolAllowlist: event.target.value })}
          rows={4}
          value={draft.toolAllowlist}
        />
        {draft.toolAllowlist.trim() !== "" && !form.toolAllowlist.ok ? (
          <ErrorMessage>{form.toolAllowlist.message}</ErrorMessage>
        ) : null}
        {form.toolAllowlistHint === undefined ? null : (
          <Description>{form.toolAllowlistHint}</Description>
        )}
      </Field>
      <Fieldset>
        <Legend>Authentication</Legend>
        <RadioGroup
          className="mt-3"
          onValueChange={(value: string) => {
            const auth = oneOf(form.authChoices, value);
            if (auth) onChange({ ...draft, auth });
          }}
          value={draft.auth}
        >
          {options.map((option) => (
            <RadioField disabled={!form.authChoices.includes(option)} key={option}>
              <RadioGroupItem value={option} />
              <Label>{AUTH_OPTIONS[option].label}</Label>
              <Description>{AUTH_OPTIONS[option].description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
        {secretShown ? (
          <Field className="mt-4">
            <Label>{draft.auth === "bearerToken" ? "Token" : "Header value"}</Label>
            <Description>
              Stored in the platform's credential vault. Nobody can read it back, including you.
            </Description>
            <Input
              autoComplete="off"
              aria-invalid={draft.secret !== "" && !form.auth.ok}
              onChange={(event) => onChange({ ...draft, secret: event.target.value })}
              type="password"
              value={draft.secret}
            />
          </Field>
        ) : null}
        {!form.auth.ok && (!secretShown || draft.secret !== "") ? (
          <ErrorMessage className="mt-3 block">{form.auth.message}</ErrorMessage>
        ) : null}
      </Fieldset>
    </>
  );
}

export function CreateMcpServerDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [draft, setDraft] = useState(EMPTY_SERVER_DRAFT);
  useEffect(() => {
    if (open) setDraft(EMPTY_SERVER_DRAFT);
  }, [open]);
  const form = readServerDraft(draft);

  return (
    <ActionDialog<McpServerView>
      confirmLabel="Register server"
      confirmation={typedConfirmation(environment.type, { phrase: draft.name.trim() || "create" })}
      description="Agents in this environment reach the server's allowlisted tools through a connection and a workspace grant."
      invalid={form.value === undefined}
      onClose={onClose}
      onSuccess={(server) => {
        void invalidateMcpServers(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
            serverId: server.id,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/mcp-servers/$serverId",
        });
      }}
      open={open}
      run={(idempotencyKey) => {
        if (!form.value) throw new TypeError("The server form is incomplete.");
        return createMcpServerFn({
          data: { body: createServerBody(form.value), idempotencyKey, scope },
        });
      }}
      size="xl"
      successMessage="MCP server registered"
      title="Register an MCP server"
    >
      <ServerFields draft={draft} form={form} onChange={setDraft} />
    </ActionDialog>
  );
}

export function EditMcpServerDialog({
  onClose,
  open,
  scope,
  server,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
  server: McpServerView;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [serverAtOpen, setServerAtOpen] = useState(server);
  const [draft, setDraft] = useState(() => serverDraft(server));
  useEffect(() => {
    if (!open) return;
    setServerAtOpen(server);
    setDraft(serverDraft(server));
  }, [open]);
  const form = readServerDraft(draft, serverAtOpen);
  const changes = form.value ? serverChanges(serverAtOpen, form.value) : {};

  return (
    <ActionDialog
      confirmLabel="Save changes"
      confirmation={typedConfirmation(environment.type, { phrase: server.name })}
      description="A new endpoint on a server with stored authentication needs new authentication too."
      invalid={form.value === undefined || Object.keys(changes).length === 0}
      onClose={onClose}
      onSuccess={() => void invalidateMcpServers(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        refreshOnConflict(
          updateMcpServerFn({
            data: {
              body: { ...changes, expectedVersion: serverAtOpen.version },
              idempotencyKey,
              scope,
              serverId: server.id,
            },
          }),
          () => invalidateMcpServers(queryClient, scope),
        )
      }
      size="xl"
      successMessage="MCP server updated"
      title={`Edit ${server.name}`}
    >
      <ServerFields draft={draft} form={form} onChange={setDraft} />
    </ActionDialog>
  );
}

export function DiscoverMcpServerDialog({
  onClose,
  onResult,
  open,
  scope,
  server,
}: Readonly<{
  onClose: () => void;
  onResult: (discovery: McpDiscovery) => void;
  open: boolean;
  scope: EnvironmentScope;
  server: McpServerView;
}>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Discover tools"
      confirmation={typedConfirmation(environment.type, { phrase: server.name })}
      description={
        <>
          Connects to <Code>{endpointUrl(server)}</Code>
          {server.hasAuth ? " with the stored authentication" : ""}, lists its allowlisted tools,
          and saves nothing. It fails if the server advertises a tool outside the allowlist or
          echoes the credential back.
        </>
      }
      onClose={onClose}
      onSuccess={onResult}
      open={open}
      run={(idempotencyKey) =>
        discoverMcpServerFn({ data: { idempotencyKey, scope, serverId: server.id } })
      }
      problemAction={(problem) =>
        problem.status >= 500 ? (
          <p>
            The platform reports a server that is unreachable, fails the MCP handshake, or refuses
            the stored authentication this way. Check the endpoint and the secret, then close this
            dialog and try again.
          </p>
        ) : null
      }
      successMessage={(discovery) =>
        `Discovered ${discovery.tools.length} of ${server.toolAllowlist.length} allowlisted ${server.toolAllowlist.length === 1 ? "tool" : "tools"}`
      }
      title={`Discover the tools of ${server.name}`}
    />
  );
}

function PinningNotice({ pinning }: Readonly<{ pinning: Pinning }>) {
  if (!pinning.checked) {
    return (
      <p className="text-sm/6">
        Your role or token cannot list grants (providers:read) or deployments (agents:read), so the
        console could not check which deployments would lose these tools.
      </p>
    );
  }
  const { complete, deploymentIds } = pinning;
  if (complete && deploymentIds.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 text-sm/6">
      {deploymentIds.length === 0 ? null : (
        <>
          <p>
            {deploymentIds.length === 1 ? "This deployment pins" : "These deployments pin"} an
            active grant on it. Nothing else changes: the grants stay, and the runtime denies these
            tools.
          </p>
          <ul className="flex flex-col gap-1">
            {deploymentIds.map((id) => (
              <li key={id}>
                <PublicId value={id} />
              </li>
            ))}
          </ul>
        </>
      )}
      {complete ? null : (
        <p>
          This environment has more MCP servers, connections, grants, or deployments than the
          console reads, so other deployments may also pin grants that this change affects.
        </p>
      )}
    </div>
  );
}

export function ArchiveMcpServerDialog({
  onClose,
  open,
  pinning,
  scope,
  server,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  pinning: Pinning;
  scope: EnvironmentScope;
  server: McpServerView;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const expectedVersionFor = useKeyedSnapshot<number>();
  return (
    <ActionDialog
      confirmLabel="Archive server"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: server.name })}
      description="Archiving deletes the stored authentication and stops discovery, new connections, and tool calls through this server. It cannot be undone."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateMcpServers(queryClient, scope)}
      open={open}
      run={(idempotencyKey, resend) =>
        refreshOnConflict(
          archiveMcpServerFn({
            data: {
              expectedVersion: expectedVersionFor(idempotencyKey, resend, server.version),
              idempotencyKey,
              scope,
              serverId: server.id,
            },
          }),
          () => invalidateMcpServers(queryClient, scope),
        )
      }
      successMessage="MCP server archived"
      title={`Archive ${server.name}?`}
    >
      <PinningNotice pinning={pinning} />
    </ActionDialog>
  );
}

export function CreateMcpConnectionDialog({
  onClose,
  open,
  scope,
  server,
}: Readonly<{
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
  server: McpServerView;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Add connection"
      confirmation={typedConfirmation(environment.type, { phrase: server.name })}
      description="A connection is what a workspace grant points at. After adding it, grant it to a workspace from the connections table, then pin the grant in a deployment's tool bindings."
      onClose={onClose}
      onSuccess={() => void invalidateMcpServers(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        createMcpConnectionFn({ data: { idempotencyKey, scope, serverId: server.id } })
      }
      successMessage="MCP connection added"
      title={`Add a connection to ${server.name}`}
    />
  );
}

export function RevokeMcpConnectionDialog({
  connection,
  onClose,
  open,
  pinning,
  scope,
}: Readonly<{
  connection: McpConnectionSummary;
  onClose: () => void;
  open: boolean;
  pinning: Pinning;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Revoke connection"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: connection.id.slice(-8),
      })}
      description="Tool calls through grants on this connection stop. It cannot be undone; create a new connection and grant to restore access."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateMcpServers(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        refreshOnConflict(
          revokeMcpConnectionFn({ data: { connectionId: connection.id, idempotencyKey, scope } }),
          () => invalidateMcpServers(queryClient, scope),
        )
      }
      successMessage="MCP connection revoked"
      title="Revoke this MCP connection?"
    >
      <PinningNotice pinning={pinning} />
    </ActionDialog>
  );
}
