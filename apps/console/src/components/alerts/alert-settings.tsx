import {
  useMutation,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { MONITOR_KIND_COPY, type AlertPreferences } from "../../alerts/monitor-model.ts";
import { putAlertPreferencesFn } from "../../data/alert-mutations.ts";
import { alertPreferencesQuery, monitorPagesQuery } from "../../data/alert-queries.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  Fieldset,
  Label,
  Legend,
  RadioField,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { Text } from "@/components/ui/text";
import { LoadMore } from "../list-controls.tsx";

const EMAIL_CHOICES = [
  {
    description:
      "Email me about every monitor that names me or my role, except those I mute below.",
    label: "Send me alert email",
    value: "all",
  },
  {
    description: "Stop all alert email from this organization. Alert history stays in the console.",
    label: "Send me no alert email",
    value: "none",
  },
] as const;

function sameSettings(left: AlertPreferences, right: AlertPreferences) {
  return (
    left.email === right.email &&
    left.mutedMonitorIds.length === right.mutedMonitorIds.length &&
    left.mutedMonitorIds.every((id) => right.mutedMonitorIds.includes(id))
  );
}

/**
 * The signed-in member's own alert email settings in one organization. Saving replaces them, so a
 * repeated save is harmless and needs no idempotency key.
 */
export function AlertSettings({ organizationId }: Readonly<{ organizationId: string }>) {
  const queryClient = useQueryClient();
  const { data: saved } = useSuspenseQuery(alertPreferencesQuery(organizationId));
  const pagesQuery = monitorPagesQuery({ organizationId });
  const {
    data: pages,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useSuspenseInfiniteQuery(pagesQuery);
  const monitors = pages.pages
    .flatMap((page) => page.items)
    .filter((monitor) => monitor.status !== "archived");
  const [draft, setDraft] = useState<AlertPreferences>(saved);
  const save = useMutation({
    mutationFn: () => putAlertPreferencesFn({ data: { body: draft, organizationId } }),
    onError: (error) => toast.error(error.message),
    onSuccess: (next) => {
      queryClient.setQueryData(alertPreferencesQuery(organizationId).queryKey, next);
      setDraft(next);
      toast.success("Alert email settings saved");
    },
  });
  const muted = new Set(draft.mutedMonitorIds);
  return (
    <form
      className="flex max-w-2xl flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Text>
        These settings are yours alone. They decide which alert email you get from this
        organization. Other members and webhook events are unaffected.
      </Text>
      <Fieldset>
        <Legend>Alert email</Legend>
        <RadioGroup
          onValueChange={(value) =>
            setDraft({ ...draft, email: value === "none" ? "none" : "all" })
          }
          value={draft.email}
        >
          {EMAIL_CHOICES.map((choice) => (
            <RadioField key={choice.value}>
              <RadioGroupItem value={choice.value} />
              <Label>{choice.label}</Label>
              <Description>{choice.description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
      </Fieldset>
      <Fieldset disabled={draft.email === "none"}>
        <Legend>Mute individual monitors</Legend>
        {monitors.length === 0 ? (
          <Text>The organization has no monitors yet.</Text>
        ) : (
          monitors.map((monitor) => (
            <CheckboxField key={monitor.id}>
              <Checkbox
                checked={muted.has(monitor.id)}
                onCheckedChange={(on) =>
                  setDraft({
                    ...draft,
                    mutedMonitorIds: on
                      ? [...muted, monitor.id]
                      : draft.mutedMonitorIds.filter((id) => id !== monitor.id),
                  })
                }
              />
              <Label>{monitor.name}</Label>
              <Description>{MONITOR_KIND_COPY[monitor.condition.kind].label}</Description>
            </CheckboxField>
          ))
        )}
        <LoadMore
          error={error}
          fetchNextPage={fetchNextPage}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          queryKey={pagesQuery.queryKey}
        />
      </Fieldset>
      <div>
        <Button disabled={save.isPending || sameSettings(draft, saved)} type="submit">
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
