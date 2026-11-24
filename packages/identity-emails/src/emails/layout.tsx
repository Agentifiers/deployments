import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Tailwind,
  Text,
  pixelBasedPreset,
} from "react-email";
import type { ReactNode } from "react";

export const expiryFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

export function IdentityEmailLayout(props: {
  readonly children: ReactNode;
  readonly preview: string;
}) {
  return (
    <Html lang="en">
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: { ink: "#181715", muted: "#66625c", paper: "#f7f5f1" },
            },
          },
        }}
      >
        <Head />
        <Body className="m-0 bg-paper px-4 py-8 font-sans text-ink">
          <Preview>{props.preview}</Preview>
          <Container className="mx-auto rounded-lg border border-solid border-[#dedbd5] bg-white p-8">
            <Text className="m-0 text-sm font-semibold tracking-wide text-ink">DEPLOYMENTS.AI</Text>
            <Hr className="my-6 border-solid border-[#dedbd5]" />
            {props.children}
            <Hr className="my-6 border-solid border-[#dedbd5]" />
            <Text className="m-0 text-sm text-muted">
              This is an automated security message from Deployments.ai.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
