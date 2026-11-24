import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPicker } from "../components/tenancy/organization-picker.tsx";
import { organizationsQuery, platformAdministratorQuery } from "../data/console-queries.ts";
import { showsSystem } from "../edition.ts";

export const Route = createFileRoute("/")({
  component: OrganizationPicker,
  loader: async ({ context }) => {
    // Awaited with the organizations so the System link renders the same on the server and the
    // client; prefetchQuery never throws, so a refused probe never fails the picker.
    const [organizations] = await Promise.all([
      context.queryClient.ensureQueryData(organizationsQuery()),
      showsSystem(context.edition)
        ? context.queryClient.prefetchQuery(platformAdministratorQuery())
        : undefined,
    ]);
    return organizations;
  },
});
