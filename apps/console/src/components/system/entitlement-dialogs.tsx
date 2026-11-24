import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { clearEntitlementsFn, replaceEntitlementsFn } from "../../data/system-mutations.ts";
import { invalidateStanding } from "../../data/system-queries.ts";
import { formatUsdMicros } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import type { SystemStanding } from "../../server/system-data.ts";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActionDialog } from "../action-dialog.tsx";
import {
  draftFromGrant,
  FEATURE_DRAFTS,
  parseDraft,
  PLAN_FEATURE_FIELDS,
  previewEffective,
  TENANT_LIMITS,
  type CeilingDraft,
  type EntitlementDraft,
  type EntitlementValues,
  type ModelSpendCeiling,
} from "./entitlement-draft.ts";

const CEILING_KINDS = ["inherit", "unlimited", "monthly"] as const;

export const featureText = (enabled: boolean) => (enabled ? "On" : "Off");

export function ceilingText(ceiling: ModelSpendCeiling): string {
  return ceiling === "unlimited"
    ? "Unlimited"
    : `${formatUsdMicros(ceiling.monthlyUsdMicros)} a month`;
}

/** Current and resulting effective values, with changed rows marked. */
export function EffectivePreview({
  after,
  before,
}: Readonly<{ after: EntitlementValues; before: EntitlementValues }>) {
  const rows = [
    {
      after: ceilingText(after.operatorFundedModelSpendCeiling),
      before: ceilingText(before.operatorFundedModelSpendCeiling),
      label: "Operator-funded model spend",
    },
    ...PLAN_FEATURE_FIELDS.map(({ label, name }) => ({
      after: featureText(after.features[name]),
      before: featureText(before.features[name]),
      label,
    })),
    ...TENANT_LIMITS.map(({ label, name }) => ({
      after: String(after.tenantLimits[name]),
      before: String(before.tenantLimits[name]),
      label,
    })),
  ];
  return (
    <Table aria-label="Effective entitlements after saving" dense>
      <TableHeader>
        <TableRow>
          <TableHead>Effective</TableHead>
          <TableHead>Now</TableHead>
          <TableHead>After saving</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow data-changed={row.after !== row.before || undefined} key={row.label}>
            <TableCell>{row.label}</TableCell>
            <TableCell className="tabular-nums">{row.before}</TableCell>
            <TableCell
              className={
                row.after === row.before
                  ? "tabular-nums"
                  : "font-semibold tabular-nums text-foreground"
              }
            >
              {row.after}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CeilingField({
  ceiling,
  error,
  onChange,
}: Readonly<{
  ceiling: CeilingDraft;
  error: string | undefined;
  onChange: (next: CeilingDraft) => void;
}>) {
  return (
    <Field>
      <Label>Operator-funded model spend ceiling</Label>
      <div className="flex gap-2">
        <NativeSelect
          className="w-56"
          name="ceilingKind"
          onChange={(event) => {
            const kind = oneOf(CEILING_KINDS, event.target.value);
            if (kind === "monthly") onChange({ kind, usd: "" });
            else if (kind) onChange({ kind });
          }}
          value={ceiling.kind}
        >
          <option value="inherit">Not set by this grant</option>
          <option value="unlimited">Unlimited</option>
          <option value="monthly">Monthly amount</option>
        </NativeSelect>
        {ceiling.kind === "monthly" ? (
          <Input
            aria-label="Monthly ceiling in USD"
            autoComplete="off"
            inputMode="decimal"
            name="ceilingUsd"
            onChange={(event) => onChange({ kind: "monthly", usd: event.target.value })}
            placeholder="USD, such as 100"
            value={ceiling.usd}
          />
        ) : null}
      </div>
      <Description>
        Zero gives no allowance, so model calls need the organization's model keys.
      </Description>
      {error && ceiling.kind === "monthly" && ceiling.usd !== "" ? (
        <ErrorMessage>{error}</ErrorMessage>
      ) : null}
    </Field>
  );
}

/**
 * Replaces the operator grant. A field left blank is not in the grant, so the service grant or
 * the install default decides it; the preview merges the way the platform does.
 */
export function EntitlementsEditor({
  onClose,
  organizationId,
  standing,
}: Readonly<{ onClose: () => void; organizationId: string; standing: SystemStanding }>) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EntitlementDraft>(() =>
    draftFromGrant(standing.grants.operator?.entitlements),
  );
  const parsed = parseDraft(draft);
  const errors = parsed.ok ? { limits: {} } : parsed.errors;
  const incomplete = draft.ceiling.kind === "monthly" && draft.ceiling.usd.trim() === "";
  return (
    <ActionDialog
      confirmLabel="Save grant"
      description="The operator grant wins over a service grant, field by field. API hosts apply a change within 5 seconds and the agent worker within 30."
      invalid={!parsed.ok || incomplete}
      onClose={onClose}
      onSuccess={() => void invalidateStanding(queryClient, organizationId)}
      open
      runOnce={() => {
        if (!parsed.ok) throw new Error("The grant has invalid values.");
        return replaceEntitlementsFn({ data: { body: parsed.grant, organizationId } });
      }}
      size="2xl"
      successMessage={(result) =>
        result.changed ? "Entitlements saved" : { neutral: "The grant already had these values" }
      }
      title="Operator entitlement grant"
    >
      <CeilingField
        ceiling={draft.ceiling}
        error={errors.ceiling}
        onChange={(ceiling) => setDraft({ ...draft, ceiling })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {PLAN_FEATURE_FIELDS.map(({ label, name }) => (
          <Field key={name}>
            <Label>{label}</Label>
            <NativeSelect
              name={name}
              onChange={(event) => {
                const value = oneOf(FEATURE_DRAFTS, event.target.value);
                if (value) setDraft({ ...draft, features: { ...draft.features, [name]: value } });
              }}
              value={draft.features[name]}
            >
              <option value="inherit">Not set by this grant</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </NativeSelect>
          </Field>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {TENANT_LIMITS.map(({ label, name }) => (
          <Field key={name}>
            <Label>{label}</Label>
            <Input
              autoComplete="off"
              inputMode="numeric"
              name={name}
              onChange={(event) =>
                setDraft({ ...draft, limits: { ...draft.limits, [name]: event.target.value } })
              }
              placeholder={`Default ${standing.defaults.tenantLimits[name]}`}
              value={draft.limits[name]}
            />
            {errors.limits[name] ? <ErrorMessage>{errors.limits[name]}</ErrorMessage> : null}
          </Field>
        ))}
      </div>
      <EffectivePreview
        after={parsed.ok ? previewEffective(standing, parsed.grant) : standing.effective}
        before={standing.effective}
      />
    </ActionDialog>
  );
}

export function ClearEntitlementsDialog({
  confirmation,
  onClose,
  organizationId,
  standing,
}: Readonly<{
  confirmation: string;
  onClose: () => void;
  organizationId: string;
  standing: SystemStanding;
}>) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel="Clear grant"
      confirmation={confirmation}
      description="Removes the operator grant. Every field falls to the service grant or the install defaults."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateStanding(queryClient, organizationId)}
      open
      runOnce={() => clearEntitlementsFn({ data: { organizationId } })}
      size="xl"
      successMessage={(result) =>
        result.changed ? "Operator grant cleared" : { neutral: "There was no operator grant" }
      }
      title="Clear the operator grant"
    >
      <EffectivePreview after={previewEffective(standing, undefined)} before={standing.effective} />
    </ActionDialog>
  );
}
