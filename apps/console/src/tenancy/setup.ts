/** What an organization still needs before any environment screen can open. */
export type SetupStep =
  | { readonly kind: "create-project" }
  | { readonly kind: "create-environment"; readonly projectId: string }
  | { readonly kind: "ready" };

export function nextSetupStep(
  projects: readonly {
    readonly environments: readonly unknown[];
    readonly project: { readonly id: string; readonly status: string };
  }[],
): SetupStep {
  if (projects.some((entry) => entry.environments.length > 0)) return { kind: "ready" };
  const open = projects.find((entry) => entry.project.status === "active");
  return open
    ? { kind: "create-environment", projectId: open.project.id }
    : { kind: "create-project" };
}
