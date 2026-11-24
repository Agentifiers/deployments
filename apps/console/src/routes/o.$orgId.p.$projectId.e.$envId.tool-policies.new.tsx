import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { CreatePolicy } from "../components/tool-policies/policy-editor.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { policyQuery } from "../data/tool-policy-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { duplicateDraft, EMPTY_DRAFT } from "../tool-policies/rules-editor.ts";
import { Subheading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export interface NewPolicySearch {
  readonly copyOf?: string;
}

function parseNewPolicySearch(search: Readonly<Record<string, unknown>>): NewPolicySearch {
  const { copyOf } = search;
  return typeof copyOf === "string" && ULID.test(copyOf) ? { copyOf } : {};
}

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/tool-policies/new")({
  validateSearch: (search): NewPolicySearch => parseNewPolicySearch(search),
  loaderDeps: ({ search }) => parseNewPolicySearch(search),
  loader: ({ context, deps, params }) => {
    if (deps.copyOf === undefined) return;
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(policyQuery(scope, deps.copyOf));
  },
  component: NewPolicy,
});

function DuplicateForm({ copyOf, scope }: Readonly<{ copyOf: string; scope: EnvironmentScope }>) {
  const { data: source } = useSuspenseQuery(policyQuery(scope, copyOf));
  return <CreatePolicy initial={duplicateDraft(source)} scope={scope} />;
}

function NewPolicy() {
  const { envId, orgId, projectId } = Route.useParams();
  const { copyOf } = parseNewPolicySearch(Route.useSearch());
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.createToolPolicy) {
    return (
      <Text>Your role or token scopes do not permit creating tool policies (tools:write).</Text>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Subheading>{copyOf === undefined ? "New policy" : "Duplicate policy"}</Subheading>
      <SectionBoundary resetKey={copyOf ?? "new"}>
        {copyOf === undefined ? (
          <CreatePolicy initial={EMPTY_DRAFT} scope={scope} />
        ) : (
          <DuplicateForm copyOf={copyOf} scope={scope} />
        )}
      </SectionBoundary>
    </div>
  );
}
