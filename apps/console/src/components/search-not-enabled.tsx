import { useInstallCopy } from "../edition.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";

const SURFACES = {
  brains: {
    label: "Brain",
    scope: "Asking a question runs the same search first, so it fails the same way.",
  },
  memory: { label: "Memory", scope: undefined },
} as const;

export function SearchNotEnabled({ surface }: Readonly<{ surface: "brains" | "memory" }>) {
  const { label, scope } = SURFACES[surface];
  const copy = useInstallCopy();
  return (
    <Callout>
      <CalloutTitle>{label} search may not be enabled for this organization</CalloutTitle>
      <CalloutDescription>
        <p>{copy.searchNotEnabled}</p>
        {scope ? <p>{scope}</p> : null}
      </CalloutDescription>
    </Callout>
  );
}
