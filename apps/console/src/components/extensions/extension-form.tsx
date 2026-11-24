import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { mcpServerOptionQuery } from "../../data/extension-queries.ts";
import { mcpDirectoryQuery } from "../../data/tool-directory-queries.ts";
import {
  ACTIONS,
  blankDraft,
  commonDraft,
  EFFECTS,
  EXECUTION_TYPES,
  NETWORK_MODES,
  SOURCE_LANGUAGES,
  type ExtensionDraft,
  type ExtensionTool,
  type FieldIssue,
  type FieldKey,
  type HostedSecretsDraft,
  type SourceLanguage,
} from "../../extensions/extension-draft.ts";
import { KIND_LABELS, mcpServerOptions, serverChoices } from "../../extensions/extension-state.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  Fieldset,
  Label,
  Legend,
  RadioField,
} from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "../icon.tsx";

const TYPE_DESCRIPTIONS: Readonly<Record<ExtensionDraft["type"], string>> = {
  client: "Your app runs the tool. The run pauses until you submit its output.",
  hosted_code:
    "The platform runs JavaScript, TypeScript, or Python you upload, in a fresh sandbox.",
  http_callback: "The platform posts each call to your HTTPS endpoint.",
  mcp: "A read tool on an MCP server registered in this environment.",
};

const ACTION_LABELS: Readonly<Record<(typeof ACTIONS)[number], string>> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Require approval",
};

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SourceLanguage>> = {
  cjs: "javascript",
  js: "javascript",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  ts: "typescript",
};

type Issues = Partial<Record<FieldKey, string>>;

function TextField({
  children,
  description,
  disabled,
  issue,
  label,
  multiline,
  onChange,
  placeholder,
  value,
}: Readonly<{
  children?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  issue: string | undefined;
  label: string;
  multiline?: number;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}>) {
  return (
    <Field disabled={disabled ?? false}>
      <Label>{label}</Label>
      {description ? <Description>{description}</Description> : null}
      {multiline ? (
        <Textarea
          className="font-mono"
          aria-invalid={issue !== undefined}
          onChange={(event) => onChange(event.target.value)}
          rows={multiline}
          spellCheck={false}
          value={value}
        />
      ) : (
        <Input
          autoComplete="off"
          aria-invalid={issue !== undefined}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      )}
      {issue ? <ErrorMessage>{issue}</ErrorMessage> : null}
      {children}
    </Field>
  );
}

function Choice<Value extends string>({
  label,
  labels,
  onChange,
  options,
  value,
}: Readonly<{
  label: string;
  labels?: Readonly<Record<Value, string>>;
  onChange: (value: Value) => void;
  options: readonly Value[];
  value: Value;
}>) {
  return (
    <Field>
      <Label>{label}</Label>
      <NativeSelect
        onChange={(event) => {
          const next = oneOf(options, event.target.value);
          if (next) onChange(next);
        }}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels?.[option] ?? option}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function ExtensionFields({
  draft,
  issues,
  onChange,
  scope,
  tool,
}: Readonly<{
  draft: ExtensionDraft;
  issues: readonly FieldIssue[];
  onChange: (draft: ExtensionDraft) => void;
  scope: EnvironmentScope;
  tool?: ExtensionTool;
}>) {
  const shown: Issues = Object.fromEntries(issues.map(({ field, message }) => [field, message]));
  return (
    <div className="flex flex-col gap-8">
      {tool === undefined ? (
        <Fieldset>
          <Legend>Execution type</Legend>
          <Text>You cannot change it after you create the extension.</Text>
          <RadioGroup
            className="mt-3"
            onValueChange={(value: string) => {
              const type = oneOf(EXECUTION_TYPES, value);
              if (type && type !== draft.type) onChange(blankDraft(type, {}, commonDraft(draft)));
            }}
            value={draft.type}
          >
            {EXECUTION_TYPES.map((type) => (
              <RadioField key={type}>
                <RadioGroupItem value={type} />
                <Label>{KIND_LABELS[type]}</Label>
                <Description>{TYPE_DESCRIPTIONS[type]}</Description>
              </RadioField>
            ))}
          </RadioGroup>
        </Fieldset>
      ) : null}
      <Fieldset className="flex flex-col gap-6">
        <Legend>Tool</Legend>
        <TextField
          description={tool ? "A tool name cannot change." : "Agents call the tool by this name."}
          disabled={tool !== undefined}
          issue={shown.name}
          label="Name"
          onChange={(name) => onChange({ ...draft, name })}
          placeholder="orders.lookup"
          value={draft.name}
        />
        <TextField
          description="The model reads it to decide when to call the tool."
          issue={shown.description}
          label="Description"
          multiline={3}
          onChange={(description) => onChange({ ...draft, description })}
          value={draft.description}
        />
        <div className="grid gap-6 sm:grid-cols-2">
          {draft.type === "mcp" ? (
            <Field>
              <Label>Effect</Label>
              <Description>MCP extensions are read tools.</Description>
            </Field>
          ) : (
            <Choice
              label="Effect"
              onChange={(effect) => onChange({ ...draft, effect })}
              options={EFFECTS}
              value={draft.effect}
            />
          )}
          <Choice
            label="Default policy action"
            labels={ACTION_LABELS}
            onChange={(defaultPolicyAction) => onChange({ ...draft, defaultPolicyAction })}
            options={ACTIONS}
            value={draft.defaultPolicyAction}
          />
        </div>
        <TextField
          description="Scopes a connection grant must hold, separated by spaces or commas."
          issue={shown.requiredScopes}
          label="Required scopes"
          onChange={(requiredScopes) => onChange({ ...draft, requiredScopes })}
          value={draft.requiredScopes}
        />
        <TextField
          description={
            <>
              A JSON Schema with <Code>type: &quot;object&quot;</Code>.
            </>
          }
          issue={shown.inputSchema}
          label="Input schema"
          multiline={8}
          onChange={(inputSchema) => onChange({ ...draft, inputSchema })}
          value={draft.inputSchema}
        />
      </Fieldset>
      <Fieldset className="flex flex-col gap-6">
        <Legend>{KIND_LABELS[draft.type]}</Legend>
        <ExecutionFields
          draft={draft}
          issues={shown}
          onChange={onChange}
          scope={scope}
          tool={tool}
        />
      </Fieldset>
      {shown.form ? <ErrorMessage>{shown.form}</ErrorMessage> : null}
    </div>
  );
}

function ExecutionFields({
  draft,
  issues,
  onChange,
  scope,
  tool,
}: Readonly<{
  draft: ExtensionDraft;
  issues: Issues;
  onChange: (draft: ExtensionDraft) => void;
  scope: EnvironmentScope;
  tool: ExtensionTool | undefined;
}>) {
  switch (draft.type) {
    case "mcp":
      return <McpFields draft={draft} issues={issues} onChange={onChange} scope={scope} />;
    case "http_callback":
      return (
        <>
          <TextField
            description="The catalog provider whose scopes the tool may require."
            issue={issues.providerKey}
            label="Provider key"
            onChange={(providerKey) => onChange({ ...draft, providerKey })}
            value={draft.providerKey}
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              issue={issues.endpointOrigin}
              label="Endpoint origin"
              onChange={(endpointOrigin) => onChange({ ...draft, endpointOrigin })}
              placeholder="https://callbacks.example.com"
              value={draft.endpointOrigin}
            />
            <TextField
              issue={issues.endpointPath}
              label="Endpoint path"
              onChange={(endpointPath) => onChange({ ...draft, endpointPath })}
              placeholder="/tools/orders"
              value={draft.endpointPath}
            />
          </div>
          <TextField
            description="Glob patterns relative to /workspace, one per line. The thread sandbox sends matching files with each call."
            issue={issues.workspaceFiles}
            label="Workspace files"
            multiline={3}
            onChange={(workspaceFiles) => onChange({ ...draft, workspaceFiles })}
            value={draft.workspaceFiles}
          />
          <CallbackSecret draft={draft} issue={issues.callbackSecret} onChange={onChange} />
        </>
      );
    case "client":
      return (
        <>
          <TextField
            description="How long a run waits for your output, from 1000 to 3600000. Empty waits 900000."
            issue={issues.timeoutMs}
            label="Timeout (ms)"
            onChange={(timeoutMs) => onChange({ ...draft, timeoutMs })}
            value={draft.timeoutMs}
          />
          <TextField
            description="Optional JSON Schema the submitted output must match."
            issue={issues.outputSchema}
            label="Output schema"
            multiline={6}
            onChange={(outputSchema) => onChange({ ...draft, outputSchema })}
            value={draft.outputSchema}
          />
        </>
      );
    case "hosted_code":
      return <HostedCodeFields draft={draft} issues={issues} onChange={onChange} tool={tool} />;
  }
}

function McpFields({
  draft,
  issues,
  onChange,
  scope,
}: Readonly<{
  draft: Extract<ExtensionDraft, { type: "mcp" }>;
  issues: Issues;
  onChange: (draft: ExtensionDraft) => void;
  scope: EnvironmentScope;
}>) {
  const { access } = useQuery(organizationShellQuery(scope.organizationId)).data ?? {};
  const [initialServerId] = useState(draft.mcpServerId);
  const directory = useQuery({
    ...mcpDirectoryQuery(scope),
    enabled: access?.listMcpServers ?? false,
  });
  const servers = directory.data ? mcpServerOptions(directory.data) : undefined;
  const beyond = useQuery({
    ...mcpServerOptionQuery(scope, initialServerId),
    enabled:
      servers?.capped === true &&
      initialServerId !== "" &&
      !servers.servers.some(({ id }) => id === initialServerId),
  });
  const choices = servers ? serverChoices(servers.servers, beyond.data ?? undefined) : [];
  const server = choices.find(({ id }) => id === draft.mcpServerId);
  if (!servers) {
    return (
      <>
        <TextField
          issue={issues.mcpServerId}
          label="MCP server ID"
          onChange={(mcpServerId) => onChange({ ...draft, mcpServerId })}
          value={draft.mcpServerId}
        />
        <TextField
          issue={issues.remoteToolName}
          label="Remote tool"
          onChange={(remoteToolName) => onChange({ ...draft, remoteToolName })}
          value={draft.remoteToolName}
        />
      </>
    );
  }
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <Field>
        <Label>MCP server</Label>
        <NativeSelect
          aria-invalid={issues.mcpServerId !== undefined}
          onChange={(event) =>
            onChange({ ...draft, mcpServerId: event.target.value, remoteToolName: "" })
          }
          value={draft.mcpServerId}
        >
          <option value="">Choose an active server</option>
          {choices.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </NativeSelect>
        {servers.capped ? (
          <Description>
            This environment has more MCP servers or connections than the console reads, so the list
            shows the active servers among the first 2,000 of each.
          </Description>
        ) : null}
        {issues.mcpServerId ? <ErrorMessage>{issues.mcpServerId}</ErrorMessage> : null}
      </Field>
      <Field disabled={server === undefined}>
        <Label>Remote tool</Label>
        <NativeSelect
          aria-invalid={issues.remoteToolName !== undefined}
          onChange={(event) => onChange({ ...draft, remoteToolName: event.target.value })}
          value={draft.remoteToolName}
        >
          <option value="">From the server&apos;s allowlist</option>
          {(server?.toolAllowlist ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </NativeSelect>
        {issues.remoteToolName ? <ErrorMessage>{issues.remoteToolName}</ErrorMessage> : null}
      </Field>
    </div>
  );
}

function CallbackSecret({
  draft,
  issue,
  onChange,
}: Readonly<{
  draft: Extract<ExtensionDraft, { type: "http_callback" }>;
  issue: string | undefined;
  onChange: (draft: ExtensionDraft) => void;
}>) {
  const { callbackSecret } = draft;
  return (
    <Field>
      <Label>Callback secret</Label>
      <Description>
        Sent as <Code>authorization: Bearer &lt;secret&gt;</Code>. The platform stores it in the
        credential vault and never shows it again.
      </Description>
      {callbackSecret.kind === "keep" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Text>The stored secret stays.</Text>
          <Button
            onClick={() => onChange({ ...draft, callbackSecret: { kind: "replace", value: "" } })}
            variant="outline"
          >
            Replace secret
          </Button>
        </div>
      ) : (
        <Input
          autoComplete="new-password"
          aria-invalid={issue !== undefined}
          onChange={(event) =>
            onChange({ ...draft, callbackSecret: { kind: "replace", value: event.target.value } })
          }
          type="password"
          value={callbackSecret.value}
        />
      )}
      {issue ? <ErrorMessage>{issue}</ErrorMessage> : null}
    </Field>
  );
}

function HostedCodeFields({
  draft,
  issues,
  onChange,
  tool,
}: Readonly<{
  draft: Extract<ExtensionDraft, { type: "hosted_code" }>;
  issues: Issues;
  onChange: (draft: ExtensionDraft) => void;
  tool: ExtensionTool | undefined;
}>) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const { source } = draft;
  const keptHash = tool?.execution.type === "hosted_code" ? tool.execution.contentHash : undefined;
  return (
    <>
      {keptHash ? (
        <CheckboxField>
          <Checkbox
            checked={source.kind === "upload"}
            onCheckedChange={(upload: boolean) =>
              onChange({
                ...draft,
                source: upload
                  ? { kind: "upload", language: "typescript", source: "" }
                  : { contentHash: keptHash, kind: "keep" },
              })
            }
          />
          <Label>Upload new source</Label>
          <Description>
            Otherwise the extension keeps artifact <Code>{keptHash.slice(0, 19)}…</Code>.
          </Description>
        </CheckboxField>
      ) : null}
      {source.kind === "upload" ? (
        <>
          <Field>
            <Label>Source file</Label>
            <FileInput
              accept=".ts,.mts,.js,.mjs,.cjs,.py"
              hint="A .ts, .js, or .py file of at most 1 MiB, or paste the source below."
              maxSize={1024 * 1024}
              onChange={(picked) => {
                setFiles(picked);
                const [file] = picked;
                if (file === undefined) return;
                const language =
                  LANGUAGE_BY_EXTENSION[file.name.split(".").pop() ?? ""] ?? source.language;
                void file
                  .text()
                  .then((text) =>
                    onChange({ ...draft, source: { kind: "upload", language, source: text } }),
                  );
              }}
              value={files}
            />
          </Field>
          <Choice
            label="Language"
            onChange={(language) => onChange({ ...draft, source: { ...source, language } })}
            options={SOURCE_LANGUAGES}
            value={source.language}
          />
          <TextField
            description="TypeScript compiles at upload. A compile error refuses the upload."
            issue={issues.source}
            label="Source"
            multiline={12}
            onChange={(text) => onChange({ ...draft, source: { ...source, source: text } })}
            value={source.source}
          />
        </>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          description="Empty uses handler."
          issue={issues.entrypoint}
          label="Entrypoint"
          onChange={(entrypoint) => onChange({ ...draft, entrypoint })}
          value={draft.entrypoint}
        />
        <Choice
          label="Network"
          onChange={(network) => onChange({ ...draft, network })}
          options={NETWORK_MODES}
          value={draft.network}
        />
        <TextField
          description="100 to 50000. Empty uses 30000."
          issue={issues.timeoutMs}
          label="Timeout (ms)"
          onChange={(timeoutMs) => onChange({ ...draft, timeoutMs })}
          value={draft.timeoutMs}
        />
        <TextField
          description="128 to 2048. Empty uses 256."
          issue={issues.memoryMiB}
          label="Memory (MiB)"
          onChange={(memoryMiB) => onChange({ ...draft, memoryMiB })}
          value={draft.memoryMiB}
        />
      </div>
      <TextField
        description="The JSON Schema the function's result must match."
        issue={issues.outputSchema}
        label="Output schema"
        multiline={6}
        onChange={(outputSchema) => onChange({ ...draft, outputSchema })}
        value={draft.outputSchema}
      />
      <HostedSecrets
        issue={issues.secrets}
        onChange={(secrets) => onChange({ ...draft, secrets })}
        secrets={draft.secrets}
        storedNames={tool?.execution.type === "hosted_code" ? tool.execution.secretNames : []}
      />
    </>
  );
}

function HostedSecrets({
  issue,
  onChange,
  secrets,
  storedNames,
}: Readonly<{
  issue: string | undefined;
  onChange: (secrets: HostedSecretsDraft) => void;
  secrets: HostedSecretsDraft;
  storedNames: readonly string[];
}>) {
  return (
    <Field>
      <Label>Secrets</Label>
      <Description>
        Environment variables the code reads. The platform stores values in the credential vault and
        shows only names. Saving secrets replaces the whole set.
      </Description>
      {secrets.kind === "keep" ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Text>
            {storedNames.length === 0 ? "No secrets." : `Stored: ${storedNames.join(", ")}.`}
          </Text>
          <Button
            onClick={() =>
              onChange({
                entries: storedNames.map((name) => ({ name, value: "" })),
                kind: "replace",
              })
            }
            variant="outline"
          >
            Replace secrets
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {secrets.entries.map((entry, index) => {
            const update = (next: { name?: string; value?: string }) =>
              onChange({
                entries: secrets.entries.map((current, position) =>
                  position === index ? { ...current, ...next } : current,
                ),
                kind: "replace",
              });
            return (
              <div className="flex items-center gap-3" key={index}>
                <Input
                  aria-label="Secret name"
                  autoComplete="off"
                  className="font-mono"
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder="BILLING_API_TOKEN"
                  value={entry.name}
                />
                <Input
                  aria-label={`Value of ${entry.name || "this secret"}`}
                  autoComplete="new-password"
                  onChange={(event) => update({ value: event.target.value })}
                  type="password"
                  value={entry.value}
                />
                <Button
                  aria-label="Remove secret"
                  onClick={() =>
                    onChange({
                      entries: secrets.entries.filter((_, position) => position !== index),
                      kind: "replace",
                    })
                  }
                  variant="ghost"
                >
                  <Icon icon={Delete02Icon} />
                </Button>
              </div>
            );
          })}
          <div>
            <Button
              onClick={() =>
                onChange({
                  entries: [...secrets.entries, { name: "", value: "" }],
                  kind: "replace",
                })
              }
              variant="outline"
            >
              <Icon icon={PlusSignIcon} />
              Add secret
            </Button>
          </div>
        </div>
      )}
      {issue ? <ErrorMessage>{issue}</ErrorMessage> : null}
    </Field>
  );
}
