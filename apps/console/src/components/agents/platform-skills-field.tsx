import { AgentPlatformSkillName } from "@deployments-ai/agent-manifest/schema";
import { getAt, setAt } from "../../agents/manifest-draft.ts";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Fieldset, Label, Legend } from "@/components/ui/field";
import { PLATFORM_SKILL_LABELS } from "./manifest-labels.ts";

const PATH = ["spec", "platformSkills"] as const;

/** Checkboxes for the skills bundled with the platform, kept in `spec.platformSkills`. */
export function PlatformSkillsField({
  onChange,
  value,
}: Readonly<{ onChange: (next: unknown) => void; value: unknown }>) {
  const raw = getAt(value, PATH);
  const selected = Array.isArray(raw) ? raw : [];
  return (
    <Fieldset>
      <Legend>Platform skills</Legend>
      <Description>Maintained by the platform and updated with each platform release.</Description>
      <div className="mt-3 flex flex-col gap-2">
        {AgentPlatformSkillName.literals.map((name) => (
          <CheckboxField key={name}>
            <Checkbox
              checked={selected.includes(name)}
              name={`platform-skill-${name}`}
              onCheckedChange={(on) => {
                const next = AgentPlatformSkillName.literals.filter((candidate) =>
                  candidate === name ? on : selected.includes(candidate),
                );
                onChange(setAt(value, PATH, next.length > 0 ? next : undefined));
              }}
            />
            <Label>{name}</Label>
            <Description>{PLATFORM_SKILL_LABELS[name]}</Description>
          </CheckboxField>
        ))}
      </div>
    </Fieldset>
  );
}
