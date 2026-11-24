import { createFileRoute, useLocation, type ErrorComponentProps } from "@tanstack/react-router";
import { ConsoleError } from "../components/console-states.tsx";
import { DeviceSignIn, DeviceSignInRequired } from "../components/device/device-sign-in.tsx";
import { sessionIdentityQuery } from "../data/console-queries.ts";
import { deviceSearch, type DeviceSearch } from "../device/device-sign-in.ts";
import { UnauthenticatedError } from "../errors.ts";

/** Where `deployments auth login` sends a person to approve the CLI; outside any organization. */
export const Route = createFileRoute("/device")({
  validateSearch: (search): DeviceSearch => deviceSearch(search),
  loader: ({ context }) => context.queryClient.ensureQueryData(sessionIdentityQuery()),
  // The code is in the query string; keep it out of Referer headers on the way out.
  head: () => ({ meta: [{ content: "strict-origin", name: "referrer" }] }),
  component: DevicePage,
  errorComponent: DeviceError,
});

function DevicePage() {
  return <DeviceSignIn code={Route.useSearch().code} />;
}

function DeviceError(props: ErrorComponentProps) {
  const search = useLocation({ select: (location) => location.search });
  if (props.error instanceof UnauthenticatedError) {
    return <DeviceSignInRequired code={deviceSearch(search).code} />;
  }
  return <ConsoleError {...props} />;
}
