import { oneOf } from "../observability/range.ts";

export const THREAD_STATES = ["active", "archived"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/** The threads list's filters; the API lists threads by recent activity and filters none of these. */
export interface ThreadFilters {
  readonly agentDeploymentId?: string;
  readonly state?: ThreadState;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export function parseThreadFilters(search: Readonly<Record<string, unknown>>): ThreadFilters {
  const { agentDeploymentId } = search;
  const state = oneOf(THREAD_STATES, search.state);
  return {
    ...(typeof agentDeploymentId === "string" && ULID.test(agentDeploymentId)
      ? { agentDeploymentId }
      : {}),
    ...(state ? { state } : {}),
  };
}

export function matchesThreadFilters(
  thread: { readonly agentDeploymentId?: string | undefined; readonly archived: boolean },
  filters: ThreadFilters,
): boolean {
  return (
    (filters.agentDeploymentId === undefined ||
      thread.agentDeploymentId === filters.agentDeploymentId) &&
    (filters.state === undefined || thread.archived === (filters.state === "archived"))
  );
}
