import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  policyOptionsQuery,
  policyPinsQuery,
  simulationQuery,
} from "../../data/tool-policy-queries.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { isLiveDeployment } from "../../connections/connection-state.ts";
import {
  parseToolNames,
  simulationInput,
  type SimulationSearch,
  type SimulationTarget,
} from "../../tool-policies/simulator-state.ts";
import { Button } from "@/components/ui/button";
import { Description, ErrorMessage, Field, FieldGroup, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionBoundary } from "../section-boundary.tsx";
import { EvaluationTable } from "../tools/evaluation-table.tsx";

const TARGETS = ["policy", "deployment"] as const satisfies readonly SimulationTarget[];
const TARGET_LABELS: Readonly<Record<SimulationTarget, string>> = {
  deployment: "A deployment",
  policy: "A policy",
};

function PolicyForm({
  onSearch,
  scope,
  search,
}: Readonly<{
  onSearch: (search: SimulationSearch) => void;
  scope: EnvironmentScope;
  search: SimulationSearch;
}>) {
  const {
    data: { complete, items: policies },
  } = useSuspenseQuery(policyOptionsQuery(scope));
  const [policy, setPolicy] = useState(search.policy ?? "");
  const [text, setText] = useState(search.tools.join("\n"));
  const tools = parseToolNames(text);
  const problem =
    tools.invalid.length > 0
      ? `Not tool names: ${tools.invalid.join(", ")}.`
      : tools.tooMany
        ? "Simulate at most 100 tools at a time."
        : undefined;
  const ready = policy !== "" && tools.names.length > 0 && problem === undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onSearch({ against: "policy", policy, tools: tools.names });
  };
  if (policies.length === 0) {
    return (
      <Text>
        {complete
          ? "The environment has no active tool policy to simulate."
          : "The console found no active tool policy among the policies it read; the environment has more than it reads."}
      </Text>
    );
  }
  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <FieldGroup>
        <Field>
          <Label>Policy</Label>
          {complete ? null : (
            <Description>
              The environment has more policies than the console reads; this list may be partial.
            </Description>
          )}
          <NativeSelect onChange={(event) => setPolicy(event.target.value)} value={policy}>
            <option disabled value="">
              Choose a policy
            </option>
            {policies.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <Label>Tools</Label>
          <Description>
            Up to 100 tool names, separated by spaces, commas, or new lines, such as{" "}
            <Code>github.issues.read</Code>.
          </Description>
          <Textarea
            className="font-mono"
            aria-invalid={problem !== undefined}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            value={text}
          />
          {problem ? <ErrorMessage>{problem}</ErrorMessage> : null}
        </Field>
      </FieldGroup>
      <div>
        <Button disabled={!ready} type="submit">
          Simulate
        </Button>
      </div>
    </form>
  );
}

function DeploymentForm({
  onSearch,
  scope,
  search,
}: Readonly<{
  onSearch: (search: SimulationSearch) => void;
  scope: EnvironmentScope;
  search: SimulationSearch;
}>) {
  const { data: pins } = useSuspenseQuery(policyPinsQuery(scope));
  const live = pins.deployments.filter(isLiveDeployment);
  const [deployment, setDeployment] = useState(search.deployment ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (deployment !== "") onSearch({ against: "deployment", deployment, tools: [] });
  };
  if (live.length === 0) {
    return (
      <Text>
        {pins.complete
          ? "The environment has no live deployment to simulate."
          : "The console found no live deployment among the deployments it read; the environment has more than it reads."}
      </Text>
    );
  }
  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <Field>
        <Label>Deployment</Label>
        <Description>
          Evaluates every tool its primary release declares, with the grants and policies it pins. A
          canary candidate is not evaluated.
          {pins.complete
            ? null
            : " The environment has more deployments than the console reads; this list may be partial."}
        </Description>
        <NativeSelect onChange={(event) => setDeployment(event.target.value)} value={deployment}>
          <option disabled value="">
            Choose a deployment
          </option>
          {live.map((option) => (
            <option key={option.deploymentId} value={option.deploymentId}>
              {option.agentName ?? option.agentDefinitionId} · …{option.deploymentId.slice(-8)} ·{" "}
              {option.desiredState}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div>
        <Button disabled={deployment === ""} type="submit">
          Simulate
        </Button>
      </div>
    </form>
  );
}

function Results({
  scope,
  search,
}: Readonly<{ scope: EnvironmentScope; search: SimulationSearch }>) {
  const { data } = useSuspenseQuery(simulationQuery(scope, search));
  return <EvaluationTable results={data.results} />;
}

export function PolicySimulator({
  canListDeployments,
  onSearch,
  scope,
  search,
}: Readonly<{
  canListDeployments: boolean;
  onSearch: (search: SimulationSearch) => void;
  scope: EnvironmentScope;
  search: SimulationSearch;
}>) {
  const input = simulationInput(search);
  const targets = canListDeployments ? TARGETS : (["policy"] as const);
  return (
    <div className="flex flex-col gap-8">
      {targets.length > 1 ? (
        <SingleToggleGroup
          aria-label="Simulate against"
          className="self-start"
          onValueChange={(next) => {
            const against = oneOf(TARGETS, next);
            if (against) onSearch({ against, tools: search.tools });
          }}
          size="sm"
          value={search.against}
        >
          {targets.map((target) => (
            <ToggleGroupItem key={target} value={target}>
              {TARGET_LABELS[target]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
      ) : null}
      <SectionBoundary resetKey={search.against}>
        {search.against === "deployment" && canListDeployments ? (
          <DeploymentForm onSearch={onSearch} scope={scope} search={search} />
        ) : (
          <PolicyForm onSearch={onSearch} scope={scope} search={search} />
        )}
      </SectionBoundary>
      {input ? (
        <section className="flex flex-col gap-4">
          {input.kind === "policy" ? (
            <Text>
              Assumes each tool runs on its own provider with its required scopes granted. Platform,
              hosted code, and client tools ignore policies and show their own default.
            </Text>
          ) : null}
          <SectionBoundary resetKey={JSON.stringify(search)}>
            <Results scope={scope} search={search} />
          </SectionBoundary>
        </section>
      ) : null}
    </div>
  );
}
