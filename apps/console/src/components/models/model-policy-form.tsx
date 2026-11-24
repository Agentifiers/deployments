import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { activeModelPolicyQuery } from "../../data/model-queries.ts";
import {
  draftFrom,
  policyTransition,
  type ModelPolicyDraft,
} from "../../models/model-policy-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Description,
  Field,
  FieldGroup,
  Fieldset,
  Label,
  SwitchField,
} from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { SaveModelPolicyDialog } from "./model-policy-dialogs.tsx";

export function ModelPolicyForm({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: active } = useSuspenseQuery(activeModelPolicyQuery(scope));
  // Pinned at open, so a save after someone else's change fails with version_conflict instead of overwriting it.
  const [policy] = useState(active ?? undefined);
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ModelPolicyDraft>(() => draftFrom(policy));
  const [reviewing, setReviewing] = useState(false);
  const transition = policyTransition(policy, draft);
  const unchanged = transition.kind === "update" && Object.keys(transition.patch).length === 0;
  const ready = draft.name.trim().length > 0 && !unchanged;
  const policyPath = `${environmentPath(scope)}/models/policy`;
  const set = (patch: Partial<ModelPolicyDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) setReviewing(true);
  };

  return (
    <>
      <form className="flex max-w-2xl flex-col gap-6" onSubmit={submit}>
        <Subheading>{policy ? `Edit ${policy.name}` : "Create a model policy"}</Subheading>
        <Fieldset>
          <FieldGroup>
            <Field>
              <Label>Name</Label>
              <Input
                maxLength={120}
                name="name"
                onChange={(event) => set({ name: event.target.value })}
                value={draft.name}
              />
            </Field>
            <Field>
              <Label>Description</Label>
              <Textarea
                maxLength={2000}
                name="description"
                onChange={(event) => set({ description: event.target.value })}
                rows={2}
                value={draft.description}
              />
            </Field>
            <SwitchField>
              <Label>Allow the curated models</Label>
              <Description>
                The platform&apos;s short list of curated models, which run without a catalog entry.
              </Description>
              <Switch
                checked={draft.includeCuratedModels}
                name="includeCuratedModels"
                onCheckedChange={(includeCuratedModels) => set({ includeCuratedModels })}
              />
            </SwitchField>
            <Field>
              <Label>Also allow</Label>
              <Description>
                One entry per line: an exact model ID from the{" "}
                <TextLink href={`${environmentPath(scope)}/models`}>catalog</TextLink>, or a whole
                provider: <Code>openai/*</Code>, <Code>openrouter/*</Code>, or{" "}
                <Code>bedrock/*</Code>. At most 256 entries.
              </Description>
              <Textarea
                className="font-mono"
                name="models"
                onChange={(event) => set({ entries: event.target.value })}
                rows={8}
                value={draft.entries}
              />
            </Field>
          </FieldGroup>
        </Fieldset>
        {unchanged ? <Text>Nothing has changed yet.</Text> : null}
        <div className="flex gap-3">
          <Button disabled={!ready} type="submit">
            Review impact
          </Button>
          <Button href={policyPath} variant="ghost">
            Cancel
          </Button>
        </div>
      </form>
      <SaveModelPolicyDialog
        active={policy}
        draft={draft}
        onClose={() => setReviewing(false)}
        onSaved={() => void navigate({ to: policyPath })}
        open={reviewing}
        scope={scope}
      />
    </>
  );
}
