import { PublicId } from "../public-id.tsx";

export function GrantWorkspace({
  names,
  workspaceId,
}: Readonly<{ names: ReadonlyMap<string, string>; workspaceId: string | null }>) {
  if (workspaceId === null) return "All workspaces";
  return names.get(workspaceId) ?? <PublicId value={workspaceId} />;
}
