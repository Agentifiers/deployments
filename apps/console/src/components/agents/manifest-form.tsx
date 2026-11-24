import {
  AgentMemoryMode,
  AgentMemoryReviewMode,
  AgentMemoryTranscriptPrivacy,
  AgentTrigger,
  MAX_AGENT_SKILL_CHARACTERS,
  MAX_AGENT_SKILL_COUNT,
} from "@deployments-ai/agent-manifest/schema";
import { CURATED_MODEL_IDS } from "@deployments-ai/model-gateway/model-policy";
import { useId, useState, type ReactNode } from "react";
import { slugFromName } from "../../tenancy/slug.ts";
import {
  getAt,
  isJsonObject,
  issuesUnder,
  setAt,
  type JsonPath,
  type ManifestIssue,
} from "../../agents/manifest-draft.ts";
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
  SwitchField,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import {
  INSTRUCTIONS_PLACEHOLDER,
  MEMORY_MODE_LABELS,
  REVIEW_MODE_LABELS,
  SANDBOX_LABELS,
  TRANSCRIPT_PRIVACY_LABELS,
  TRIGGER_LABELS,
} from "./manifest-labels.ts";
import { PlatformSkillsField } from "./platform-skills-field.tsx";

const PATHS = {
  fallbackIds: ["spec", "model", "fallbackIds"],
  instructions: ["spec", "instructions"],
  key: ["metadata", "key"],
  memory: ["spec", "memory"],
  modelId: ["spec", "model", "id"],
  modelTools: ["spec", "runtime", "modelTools"],
  name: ["metadata", "name"],
  runtime: ["spec", "runtime"],
  sandboxMode: ["spec", "sandbox", "mode"],
  skills: ["spec", "skills"],
  tools: ["spec", "capabilities", "tools"],
  triggers: ["spec", "triggers"],
  version: ["metadata", "version"],
} as const satisfies Readonly<Record<string, JsonPath>>;

type Tool = Readonly<Record<string, unknown>>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function parseList(input: string): readonly string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function FieldIssues({
  issues,
  path,
}: Readonly<{ issues: readonly ManifestIssue[]; path: JsonPath }>) {
  const under = issuesUnder(issues, path);
  if (under.length === 0) return null;
  return (
    <ErrorMessage>
      {[...new Set(under.map((issue) => issue.message))].map((message) => (
        <span className="block" key={message}>
          {message}
        </span>
      ))}
    </ErrorMessage>
  );
}

/**
 * A comma-separated list. The text is kept locally so a trailing comma survives typing; it is
 * re-read from the manifest when the list changes elsewhere, such as in the JSON view.
 */
function ListInput({
  invalid,
  label,
  name,
  onChange,
  value,
}: Readonly<{
  invalid: boolean;
  label: string;
  name: string;
  onChange: (next: readonly string[]) => void;
  value: readonly string[];
}>) {
  const [input, setInput] = useState(value.join(", "));
  if (parseList(input).join("\n") !== value.join("\n")) setInput(value.join(", "));
  return (
    <Input
      aria-invalid={invalid || undefined}
      aria-label={label}
      name={name}
      onChange={(event) => {
        setInput(event.target.value);
        onChange(parseList(event.target.value));
      }}
      value={input}
    />
  );
}

function Section({ children, legend }: Readonly<{ children: ReactNode; legend: string }>) {
  return (
    <Fieldset className="rounded-lg border border-border p-4">
      <Legend>{legend}</Legend>
      {children}
    </Fieldset>
  );
}

interface FormProps {
  readonly issues: readonly ManifestIssue[];
  readonly onChange: (next: unknown) => void;
  readonly value: unknown;
}

function TextField({
  description,
  issues,
  label,
  onChange,
  path,
  value,
}: FormProps & Readonly<{ description?: string; label: string; path: JsonPath }>) {
  const invalid = issuesUnder(issues, path).length > 0;
  return (
    <Field>
      <Label>{label}</Label>
      {description ? <Description>{description}</Description> : null}
      <Input
        aria-invalid={invalid || undefined}
        name={path.join(".")}
        onChange={(event) => onChange(setAt(value, path, event.target.value))}
        value={text(getAt(value, path))}
      />
      <FieldIssues issues={issues} path={path} />
    </Field>
  );
}

function IdentitySection(props: FormProps) {
  return (
    <Section legend="Identity">
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField {...props} label="Name" path={PATHS.name} />
        <TextField
          {...props}
          description="Unique in the environment; also the agent's slug."
          label="Key"
          path={PATHS.key}
        />
        <TextField {...props} label="Version" path={PATHS.version} />
      </div>
    </Section>
  );
}

/** Whether the draft has no instructions yet: unfinished rather than wrong, so it asks for them. */
export function instructionsMissing(value: unknown) {
  return text(getAt(value, PATHS.instructions)) === "";
}

function InstructionsField({ issues, onChange, value }: FormProps) {
  const instructions = text(getAt(value, PATHS.instructions));
  const missing = instructionsMissing(value);
  const shown = missing ? [] : issues;
  return (
    <Field>
      <Label>Instructions</Label>
      {missing ? <Description>Required. Enter instructions to save the agent.</Description> : null}
      <Textarea
        aria-invalid={issuesUnder(shown, PATHS.instructions).length > 0 || undefined}
        name="spec.instructions"
        onChange={(event) => onChange(setAt(value, PATHS.instructions, event.target.value))}
        placeholder={INSTRUCTIONS_PLACEHOLDER}
        required
        rows={10}
        value={instructions}
      />
      <FieldIssues issues={shown} path={PATHS.instructions} />
    </Field>
  );
}

function ModelFields({ issues, onChange, value }: FormProps) {
  const listId = useId();
  const fallbacks = strings(getAt(value, PATHS.fallbackIds));
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <Label>Model</Label>
          <Description>Any model the environment&apos;s model policy admits.</Description>
          <Input
            aria-invalid={issuesUnder(issues, PATHS.modelId).length > 0 || undefined}
            list={listId}
            name="spec.model.id"
            onChange={(event) => onChange(setAt(value, PATHS.modelId, event.target.value))}
            value={text(getAt(value, PATHS.modelId))}
          />
          <datalist id={listId}>
            {CURATED_MODEL_IDS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <FieldIssues issues={issues} path={PATHS.modelId} />
        </Field>
        <Field>
          <Label>Fallback models</Label>
          <Description>Comma-separated, tried in order. At most three.</Description>
          <ListInput
            invalid={issuesUnder(issues, PATHS.fallbackIds).length > 0}
            label="Fallback models"
            name="spec.model.fallbackIds"
            onChange={(next) =>
              onChange(setAt(value, PATHS.fallbackIds, next.length > 0 ? next : undefined))
            }
            value={fallbacks}
          />
          <FieldIssues issues={issues} path={PATHS.fallbackIds} />
        </Field>
      </div>
      <Field className="sm:w-1/2">
        <Label>Sandbox</Label>
        <NativeSelect
          name="spec.sandbox.mode"
          onChange={(event) => onChange(setAt(value, PATHS.sandboxMode, event.target.value))}
          value={text(getAt(value, PATHS.sandboxMode))}
        >
          {Object.entries(SANDBOX_LABELS).map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <FieldIssues issues={issues} path={["spec", "sandbox"]} />
      </Field>
    </>
  );
}

function BehaviorSection(props: FormProps) {
  return (
    <Section legend="Behavior">
      <InstructionsField {...props} />
      <ModelFields {...props} />
    </Section>
  );
}

function TriggersSection({ issues, onChange, value }: FormProps) {
  const raw = getAt(value, PATHS.triggers);
  const triggers = raw === undefined ? undefined : strings(raw);
  return (
    <Section legend="Triggers">
      <SwitchField>
        <Label>Accept every trigger</Label>
        <Description>
          Turn off to list the triggers that may start a run. Email inbox bindings route only to
          agents that accept the email trigger.
        </Description>
        <Switch
          checked={triggers === undefined}
          name="triggers-unrestricted"
          onCheckedChange={(all) =>
            onChange(setAt(value, PATHS.triggers, all ? undefined : [...AgentTrigger.literals]))
          }
        />
      </SwitchField>
      {triggers === undefined ? null : (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {AgentTrigger.literals.map((trigger) => (
            <CheckboxField key={trigger}>
              <Checkbox
                checked={triggers.includes(trigger)}
                name={`trigger-${trigger}`}
                onCheckedChange={(on) =>
                  onChange(
                    setAt(
                      value,
                      PATHS.triggers,
                      AgentTrigger.literals.filter((candidate) =>
                        candidate === trigger ? on : triggers.includes(candidate),
                      ),
                    ),
                  )
                }
              />
              <Label>{TRIGGER_LABELS[trigger]}</Label>
            </CheckboxField>
          ))}
        </div>
      )}
      <FieldIssues issues={issues} path={PATHS.triggers} />
    </Section>
  );
}

/**
 * Writes the tool list and keeps `runtime.modelTools` naming only declared tools: a renamed tool
 * stays visible to the model under its new name, and a removed one leaves the allowlist.
 */
function withTools(value: unknown, tools: readonly Tool[], modelTools: readonly string[]): unknown {
  const withCapabilities = setAt(
    value,
    ["spec", "capabilities"],
    tools.length > 0 ? { tools } : undefined,
  );
  const withModelTools = setAt(
    withCapabilities,
    PATHS.modelTools,
    modelTools.length > 0 ? modelTools : undefined,
  );
  const runtime = getAt(withModelTools, PATHS.runtime);
  return isJsonObject(runtime) && Object.keys(runtime).length === 0
    ? setAt(withModelTools, PATHS.runtime, undefined)
    : withModelTools;
}

function ToolRow({
  index,
  issues,
  modelTools,
  onChange,
  tools,
  value,
}: FormProps & Readonly<{ index: number; modelTools: readonly string[]; tools: readonly Tool[] }>) {
  const tool = tools[index] ?? {};
  const name = text(tool.name);
  const path = [...PATHS.tools, index];
  const replace = (next: Tool) => {
    const nextTools = tools.map((candidate, at) => (at === index ? next : candidate));
    const renamed = text(next.name);
    onChange(
      withTools(
        value,
        nextTools,
        modelTools.map((model) => (model === name ? renamed : model)),
      ),
    );
  };
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr]">
        <Field>
          <Label>Tool name</Label>
          <Input
            aria-invalid={issuesUnder(issues, [...path, "name"]).length > 0 || undefined}
            name={`tool-${index}-name`}
            onChange={(event) => replace({ ...tool, name: event.target.value })}
            value={name}
          />
        </Field>
        <Field>
          <Label>Authorization</Label>
          <NativeSelect
            name={`tool-${index}-authorization`}
            onChange={(event) => {
              const { authorization: _previous, ...rest } = tool;
              replace(
                event.target.value === "" ? rest : { ...rest, authorization: event.target.value },
              );
            }}
            value={text(tool.authorization)}
          >
            <option value="">Not set</option>
            <option value="none">none</option>
            <option value="workspace">workspace</option>
          </NativeSelect>
        </Field>
        <Field>
          <Label>Required scopes</Label>
          <ListInput
            invalid={issuesUnder(issues, [...path, "requiredScopes"]).length > 0}
            label={`Required scopes of tool ${index + 1}`}
            name={`tool-${index}-scopes`}
            onChange={(next) => replace({ ...tool, requiredScopes: next })}
            value={strings(tool.requiredScopes)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <CheckboxField>
          <Checkbox
            checked={tool.required === true}
            name={`tool-${index}-required`}
            onCheckedChange={(required) => replace({ ...tool, required })}
          />
          <Label>Required to deploy</Label>
        </CheckboxField>
        <CheckboxField>
          <Checkbox
            checked={modelTools.includes(name)}
            disabled={name === ""}
            name={`tool-${index}-model`}
            onCheckedChange={(on) =>
              onChange(
                withTools(
                  value,
                  tools,
                  on ? [...modelTools, name] : modelTools.filter((model) => model !== name),
                ),
              )
            }
          />
          <Label>Model can call it</Label>
        </CheckboxField>
        <Button
          className="ml-auto"
          onClick={() =>
            onChange(
              withTools(
                value,
                tools.filter((_, at) => at !== index),
                modelTools.filter((model) => model !== name),
              ),
            )
          }
          size="sm"
          variant="ghost"
        >
          Remove tool
        </Button>
      </div>
      <FieldIssues issues={issues} path={path} />
    </div>
  );
}

function ToolsSection(props: FormProps) {
  const { issues, onChange, value } = props;
  const rawTools = getAt(value, PATHS.tools);
  const tools: readonly Tool[] = Array.isArray(rawTools) ? rawTools.filter(isJsonObject) : [];
  const modelTools = strings(getAt(value, PATHS.modelTools));
  return (
    <Section legend="Tools">
      <Text>
        Tools the agent declares. A deployment binds workspace-authorized tools to connections; only
        tools marked &quot;Model can call it&quot; are offered to the model.
      </Text>
      {tools.map((_, index) => (
        <ToolRow {...props} index={index} key={index} modelTools={modelTools} tools={tools} />
      ))}
      <FieldIssues issues={issues} path={PATHS.modelTools} />
      <Button
        className="self-start"
        onClick={() =>
          onChange(
            withTools(
              value,
              [...tools, { name: "", required: false, requiredScopes: [] }],
              modelTools,
            ),
          )
        }
        variant="outline"
      >
        Add tool
      </Button>
    </Section>
  );
}

function SkillsSection({ issues, onChange, value }: FormProps) {
  const skills = strings(getAt(value, PATHS.skills));
  const write = (next: readonly string[]) =>
    onChange(setAt(value, PATHS.skills, next.length > 0 ? next : undefined));
  return (
    <Section legend="Skills">
      <PlatformSkillsField onChange={onChange} value={value} />
      <Text>
        Pinned skill text added to the instructions: up to {MAX_AGENT_SKILL_COUNT} skills of{" "}
        {MAX_AGENT_SKILL_CHARACTERS.toLocaleString("en-US")} characters each.
      </Text>
      {skills.map((skill, index) => (
        <Field key={index}>
          <div className="flex items-center gap-3">
            <Label>Skill {index + 1}</Label>
            <span className="text-xs text-muted-foreground">
              {skill.length.toLocaleString("en-US")} /{" "}
              {MAX_AGENT_SKILL_CHARACTERS.toLocaleString("en-US")}
            </span>
            <Button
              className="ml-auto"
              onClick={() => write(skills.filter((_, at) => at !== index))}
              size="sm"
              variant="ghost"
            >
              Remove skill
            </Button>
          </div>
          <Textarea
            aria-invalid={issuesUnder(issues, [...PATHS.skills, index]).length > 0 || undefined}
            name={`skill-${index}`}
            onChange={(event) =>
              write(skills.map((candidate, at) => (at === index ? event.target.value : candidate)))
            }
            rows={4}
            value={skill}
          />
          <FieldIssues issues={issues} path={[...PATHS.skills, index]} />
        </Field>
      ))}
      <Button
        className="self-start"
        disabled={skills.length >= MAX_AGENT_SKILL_COUNT}
        onClick={() => write([...skills, ""])}
        variant="outline"
      >
        Add skill
      </Button>
    </Section>
  );
}

function MemorySection({ issues, onChange, value }: FormProps) {
  const memory = getAt(value, PATHS.memory);
  const mode = isJsonObject(memory) ? text(memory.mode) : "";
  const reviewMode = isJsonObject(memory) ? text(memory.reviewMode) : "";
  const transcriptPrivacy = isJsonObject(memory) ? text(memory.transcriptPrivacy) : "";
  const write = (nextMode: string, nextReview: string, nextPrivacy = transcriptPrivacy) =>
    onChange(
      setAt(
        value,
        PATHS.memory,
        nextMode === ""
          ? undefined
          : {
              mode: nextMode,
              ...(nextReview === "" ? {} : { reviewMode: nextReview }),
              ...(nextPrivacy === "" ? {} : { transcriptPrivacy: nextPrivacy }),
            },
      ),
    );
  return (
    <Section legend="Memory">
      <Text>
        An agent remembers only in a memory space of its scope that it holds a read-write grant on.
        A workspace-scope agent gets its workspace&apos;s default space, a grant, and a recall
        policy after its first run there, and its memories there are approved unless review is set
        to manual. Other scopes need a space, grant, and policy set up on the environment&apos;s
        Memory page, and their workspace and organization memories wait for review unless review is
        auto-approve. Runs of a workspace-scope agent must name a workspace.
      </Text>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <Label>Memory scope</Label>
          <NativeSelect
            name="spec.memory.mode"
            onChange={(event) => write(event.target.value, reviewMode)}
            value={mode}
          >
            <option value="">Not set</option>
            {AgentMemoryMode.literals.map((literal) => (
              <option key={literal} value={literal}>
                {MEMORY_MODE_LABELS[literal]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <Label>Review of new memories</Label>
          <NativeSelect
            disabled={mode === ""}
            name="spec.memory.reviewMode"
            onChange={(event) => write(mode, event.target.value)}
            value={reviewMode}
          >
            <option value="">Not set</option>
            {AgentMemoryReviewMode.literals.map((literal) => (
              <option key={literal} value={literal}>
                {REVIEW_MODE_LABELS[literal]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <Label>Messages with personal data</Label>
          <NativeSelect
            disabled={mode === ""}
            name="spec.memory.transcriptPrivacy"
            onChange={(event) => write(mode, reviewMode, event.target.value)}
            value={transcriptPrivacy}
          >
            <option value="">Not set</option>
            {AgentMemoryTranscriptPrivacy.literals.map((literal) => (
              <option key={literal} value={literal}>
                {TRANSCRIPT_PRIVACY_LABELS[literal]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <FieldIssues issues={issues} path={PATHS.memory} />
    </Section>
  );
}

/** A new agent's key follows its name while the key still equals the one the name derives. */
function withDerivedKey(previous: unknown, next: unknown): unknown {
  const derived = (manifest: unknown) => slugFromName(text(getAt(manifest, PATHS.name)));
  return text(getAt(previous, PATHS.key)) === derived(previous)
    ? setAt(next, PATHS.key, derived(next))
    : next;
}

/**
 * The common manifest fields as a form over the parsed draft. Every change writes the whole
 * manifest back, so fields the form does not show pass through untouched. The `create` layout
 * asks for a name and instructions first and folds the rest under Advanced.
 */
export function ManifestForm({
  layout = "full",
  ...props
}: FormProps & Readonly<{ layout?: "create" | "full" | undefined }>) {
  if (layout === "create") {
    return (
      <div className="flex flex-col gap-6">
        <Section legend="Agent">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              {...props}
              label="Name"
              onChange={(next) => props.onChange(withDerivedKey(props.value, next))}
              path={PATHS.name}
            />
            <TextField
              {...props}
              description="Follows the name until you edit it. Unique in the environment; also the agent's slug."
              label="Key"
              path={PATHS.key}
            />
          </div>
          <InstructionsField {...props} />
        </Section>
        <details className="group flex flex-col rounded-lg border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm/6 font-medium">
            Advanced: model, sandbox, triggers, tools, skills, and memory
          </summary>
          <div className="flex flex-col gap-6 px-4 pb-4">
            <Section legend="Model and sandbox">
              <ModelFields {...props} />
              <TextField
                {...props}
                description="Your own label for this manifest, such as 1.0.0."
                label="Manifest version"
                path={PATHS.version}
              />
            </Section>
            <TriggersSection {...props} />
            <ToolsSection {...props} />
            <SkillsSection {...props} />
            <MemorySection {...props} />
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <IdentitySection {...props} />
      <BehaviorSection {...props} />
      <TriggersSection {...props} />
      <ToolsSection {...props} />
      <SkillsSection {...props} />
      <MemorySection {...props} />
    </div>
  );
}
