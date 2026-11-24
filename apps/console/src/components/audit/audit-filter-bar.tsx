import { useState, type FormEvent } from "react";
import {
  AUDIT_ACTIONS,
  auditDraft,
  isFiltered,
  readAuditDraft,
  type AuditFilterDraft,
  type AuditFilterField,
  type AuditFilters,
  type AuditScope,
} from "../../audit/audit-state.ts";
import { Button } from "@/components/ui/button";
import { ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const FIELDS: readonly {
  readonly field: AuditFilterField;
  readonly label: string;
  readonly placeholder: string;
  readonly type: "datetime-local" | "text";
}[] = [
  { field: "event", label: "Event", placeholder: "", type: "text" },
  {
    field: "actor",
    label: "Actor ID",
    placeholder: "Principal or service account ID",
    type: "text",
  },
  {
    field: "resource",
    label: "Resource ID",
    placeholder: "ID of the changed resource",
    type: "text",
  },
  { field: "since", label: "From", placeholder: "", type: "datetime-local" },
  { field: "until", label: "Before", placeholder: "", type: "datetime-local" },
];

export function AuditFilterBar({
  filters,
  onFilters,
  scope,
}: Readonly<{
  filters: AuditFilters;
  onFilters: (filters: AuditFilters) => void;
  scope: AuditScope;
}>) {
  const [draft, setDraft] = useState<AuditFilterDraft>(() => auditDraft(filters));
  const result = readAuditDraft(draft);
  const issues = result.kind === "invalid" ? result.issues : {};
  const listId = `audit-actions-${scope}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (result.kind === "valid") onFilters(result.filters);
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {FIELDS.map(({ field, label, placeholder, type }) => (
          <Field key={field}>
            <Label>{label}</Label>
            <Input
              autoComplete="off"
              aria-invalid={issues[field] !== undefined}
              {...(field === "event" ? { list: listId } : {})}
              name={field}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              placeholder={field === "event" ? (AUDIT_ACTIONS[scope][0] ?? "") : placeholder}
              type={type}
              value={draft[field]}
            />
            {issues[field] ? <ErrorMessage>{issues[field]}</ErrorMessage> : null}
          </Field>
        ))}
      </div>
      <datalist id={listId}>
        {AUDIT_ACTIONS[scope].map((action) => (
          <option key={action} value={action} />
        ))}
      </datalist>
      <div className="flex gap-3">
        <Button disabled={result.kind === "invalid"} type="submit">
          Apply filters
        </Button>
        {isFiltered(filters) ? (
          <Button onClick={() => onFilters({})} variant="ghost" type="button">
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}
