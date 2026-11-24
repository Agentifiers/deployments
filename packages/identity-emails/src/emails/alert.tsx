import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Tailwind,
  Text,
  pixelBasedPreset,
} from "react-email";
import { expiryFormat } from "./layout.tsx";

export type AlertEmailStatus = "fired" | "renotified" | "resolved" | "test";

export interface AlertEmailProps {
  /** Opens the incident (or, for a test, the monitor) in the console. */
  readonly actionUrl: string;
  readonly monitorName: string;
  /** Where the member changes which alert emails they get. */
  readonly preferencesUrl: string;
  /** Name of the install that sends the email, as the console shows it. */
  readonly productName: string;
  /** When the incident opened (ISO-8601); rendered as a UTC date and time. */
  readonly openedAt: string;
  readonly scopeLabel: string;
  readonly status: AlertEmailStatus;
  readonly summary: string;
}

const HEADLINE: Readonly<Record<AlertEmailStatus, string>> = {
  fired: "Alert firing",
  renotified: "Alert still firing",
  resolved: "Alert resolved",
  test: "Test alert",
};

const ACTION: Readonly<Record<AlertEmailStatus, string>> = {
  fired: "Open alert",
  renotified: "Open alert",
  resolved: "View alert history",
  test: "Open monitor",
};

export function alertEmailSubject(props: Pick<AlertEmailProps, "monitorName" | "status">) {
  const prefix = {
    fired: "[Firing]",
    renotified: "[Still firing]",
    resolved: "[Resolved]",
    test: "[Test]",
  }[props.status];
  return `${prefix} ${props.monitorName}`;
}

/** One alert notification: what fired, where, since when, and the links to act on it. */
export function AlertEmail(props: AlertEmailProps) {
  return (
    <Html lang="en">
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: {
                firing: "#b42318",
                ink: "#181715",
                muted: "#66625c",
                paper: "#f7f5f1",
                resolved: "#067647",
              },
            },
          },
        }}
      >
        <Head />
        <Body className="m-0 bg-paper px-4 py-8 font-sans text-ink">
          <Preview>{`${HEADLINE[props.status]}: ${props.monitorName}. ${props.summary}`}</Preview>
          <Container className="mx-auto rounded-lg border border-solid border-[#dedbd5] bg-white p-8">
            <Text className="m-0 text-sm font-semibold tracking-wide text-ink">
              {props.productName.toUpperCase()}
            </Text>
            <Hr className="my-6 border-solid border-[#dedbd5]" />
            <Text
              className={`m-0 text-sm font-semibold ${
                props.status === "resolved" ? "text-resolved" : "text-firing"
              }`}
            >
              {HEADLINE[props.status]}
            </Text>
            <Heading as="h1" className="mb-2 mt-1 text-2xl font-semibold text-ink">
              {props.monitorName}
            </Heading>
            <Text className="mt-0 text-base leading-6 text-ink">{props.summary}</Text>
            <Text className="text-sm leading-5 text-muted">
              {props.scopeLabel}
              <br />
              Opened {expiryFormat.format(new Date(props.openedAt))} UTC
            </Text>
            <Button
              href={props.actionUrl}
              className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
            >
              {ACTION[props.status]}
            </Button>
            <Hr className="my-6 border-solid border-[#dedbd5]" />
            <Text className="m-0 text-sm leading-5 text-muted">
              You get this email because a monitor in your organization notifies you.{" "}
              <Link href={props.preferencesUrl} className="text-muted underline">
                Change your alert emails
              </Link>
              .
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

AlertEmail.PreviewProps = {
  actionUrl: "https://app.us.deployments.ai/o/01ARZ3NDEKTSV4RRFFQ69G5FAV/alerts",
  monitorName: "Checkout agent failing",
  openedAt: "2026-11-02T10:15:00.000Z",
  preferencesUrl: "https://app.us.deployments.ai/o/01ARZ3NDEKTSV4RRFFQ69G5FAV/alerts/settings",
  productName: "Deployments.ai",
  scopeLabel: "Production environment",
  status: "fired",
  summary: "5 failed runs in the last 15 minutes (threshold 3).",
} satisfies AlertEmailProps;

export default AlertEmail;
