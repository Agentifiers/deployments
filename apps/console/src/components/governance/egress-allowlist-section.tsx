import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { replaceEgressAllowlistFn } from "../../data/governance-mutations.ts";
import { egressAllowlistQuery, invalidateGovernance } from "../../data/governance-queries.ts";
import {
  allowlistChange,
  candidateProblem,
  entriesOf,
  rowsOf,
  type AllowlistRow,
} from "../../governance/egress-allowlist-state.ts";
import { Button } from "@/components/ui/button";
import { ErrorMessage, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

const EMPTY_ROW: AllowlistRow = { note: "", origin: "" };

type SaveResult = Awaited<ReturnType<typeof replaceEgressAllowlistFn>>;

/**
 * The organization's egress allowlist, shown only inside a data boundary. Owners and admins edit
 * a draft of the whole list and save it in one replace; everyone else reads it.
 */
export function EgressAllowlistSection({
  canEdit,
  organizationId,
}: Readonly<{ canEdit: boolean; organizationId: string }>) {
  const queryClient = useQueryClient();
  const { data: saved } = useSuspenseQuery(egressAllowlistQuery(organizationId));
  const [base, setBase] = useState(saved);
  const [rows, setRows] = useState(() => rowsOf(saved.entries));
  const [candidate, setCandidate] = useState(EMPTY_ROW);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const held = useKeyedSnapshot<readonly AllowlistRow[]>();
  // A save or a refetch after a conflict brings a newer list; the draft starts over from it.
  if (base.version !== saved.version) {
    setBase(saved);
    setRows(rowsOf(saved.entries));
  }
  const change = allowlistChange(saved.entries, rows);
  const dirty = change.added.length > 0 || change.removed.length > 0 || change.notesChanged;
  const problem = candidateProblem(rows, candidate);
  const add = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem) return;
    setRows([...rows, candidate]);
    setCandidate(EMPTY_ROW);
    setTried(false);
  };
  const shown = tried || candidate.origin !== "" ? problem : undefined;
  const refresh = () => invalidateGovernance(queryClient, organizationId);
  return (
    <section aria-labelledby="egress-allowlist-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading id="egress-allowlist-heading">Egress allowlist</Subheading>
        {canEdit ? (
          <Button
            className="ml-auto"
            disabled={!dirty}
            onClick={() => setConfirming(true)}
            variant={dirty ? "default" : "outline"}
          >
            Save allowlist
          </Button>
        ) : null}
      </div>
      <Text>
        This organization is under a data boundary. Tools may send data to these https origins
        without approval. A call to any other origin, recipient, or search waits for an organization
        owner or admin to approve it.{" "}
        {saved.version === 0 || !saved.updatedAt || !saved.updatedByPrincipalId ? (
          "Nobody has listed an origin yet."
        ) : (
          <>
            Version {saved.version}, last changed <Timestamp value={saved.updatedAt} /> by{" "}
            <PublicId value={saved.updatedByPrincipalId} />.
          </>
        )}
      </Text>
      {canEdit ? null : <Text>Only organization owners and admins can change the allowlist.</Text>}
      <Table aria-label="Allowed origins">
        <TableHeader>
          <TableRow>
            <TableHead>Origin</TableHead>
            <TableHead>Note</TableHead>
            {canEdit ? <TableHead className="w-0" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground" colSpan={canEdit ? 3 : 2}>
                No origins. Every public-egress call needs approval.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.origin}>
                <TableCell>
                  <Code>{row.origin}</Code>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.note || "—"}</TableCell>
                {canEdit ? (
                  <TableCell className="text-right">
                    <Button
                      aria-label={`Remove ${row.origin}`}
                      onClick={() => setRows(rows.filter((other) => other.origin !== row.origin))}
                      size="sm"
                      variant="ghost"
                    >
                      <Icon icon={Delete02Icon} />
                      Remove
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {canEdit ? (
        <form className="grid items-start gap-3 sm:grid-cols-[2fr_3fr_auto]" onSubmit={add}>
          <Field>
            <Label>Origin</Label>
            <Input
              aria-invalid={shown?.field === "origin"}
              autoComplete="off"
              name="origin"
              onChange={(event) => setCandidate({ ...candidate, origin: event.target.value })}
              placeholder="https://api.example.com"
              value={candidate.origin}
            />
            {shown?.field === "origin" ? <ErrorMessage>{shown.message}</ErrorMessage> : null}
          </Field>
          <Field>
            <Label>Note</Label>
            <Input
              aria-invalid={shown?.field === "note"}
              autoComplete="off"
              name="note"
              onChange={(event) => setCandidate({ ...candidate, note: event.target.value })}
              placeholder="Optional, such as the vendor and agreement"
              value={candidate.note}
            />
            {shown?.field === "note" ? <ErrorMessage>{shown.message}</ErrorMessage> : null}
          </Field>
          <Button className="sm:mt-6" type="submit" variant="outline">
            <Icon icon={PlusSignIcon} />
            Add origin
          </Button>
        </form>
      ) : null}
      {canEdit ? (
        <ActionDialog<SaveResult>
          confirmLabel="Save allowlist"
          description="Tools reach the listed origins without approval as soon as this saves. Removed origins need approval again."
          onClose={() => setConfirming(false)}
          onSuccess={(result) => {
            setBase(result.allowlist);
            setRows(rowsOf(result.allowlist.entries));
            void refresh();
          }}
          open={confirming}
          run={(idempotencyKey, resend) =>
            refreshOnConflict(
              replaceEgressAllowlistFn({
                data: {
                  body: { entries: entriesOf(held(idempotencyKey, resend, rows)) },
                  idempotencyKey,
                  scope: { organizationId },
                },
              }),
              refresh,
            )
          }
          successMessage={(result) =>
            result.changed ? "Allowlist saved" : { neutral: "The allowlist already matched" }
          }
          title="Save the egress allowlist?"
        >
          <ul className="flex flex-col gap-1 text-sm">
            {change.added.map((origin) => (
              <li key={`add-${origin}`}>
                Add <Code>{origin}</Code>
              </li>
            ))}
            {change.removed.map((origin) => (
              <li key={`remove-${origin}`}>
                Remove <Code>{origin}</Code>
              </li>
            ))}
            {change.notesChanged ? <li>Update notes</li> : null}
          </ul>
        </ActionDialog>
      ) : null}
    </section>
  );
}
