export interface HumanVerificationWidget {
  readonly responseField: string;
  readonly scriptUrl: string;
  readonly siteKey: string;
  readonly widgetClass: string;
  readonly widgetOrigins: readonly string[];
}

export type HumanVerificationOutcome = "rejected" | "unavailable" | "verified";

export interface HumanVerifier {
  readonly widget: HumanVerificationWidget;
  verify(input: {
    readonly remoteIp: string | undefined;
    readonly response: string | undefined;
  }): Promise<HumanVerificationOutcome>;
}

export function makeSiteverifyHumanVerifier(input: {
  readonly fetch?: typeof fetch;
  readonly readSecret: () => Promise<string>;
  readonly timeoutMs: number;
  readonly verifyUrl: string;
  readonly widget: HumanVerificationWidget;
}): HumanVerifier {
  let secret: Promise<string> | undefined;
  const loadSecret = () => {
    secret ??= input.readSecret().catch((error: unknown) => {
      secret = undefined;
      throw error;
    });
    return secret;
  };
  const send = input.fetch ?? fetch;
  return {
    widget: input.widget,
    async verify({ remoteIp, response }) {
      if (!response) return "rejected";
      try {
        const form = new URLSearchParams({ response, secret: await loadSecret() });
        if (remoteIp) form.set("remoteip", remoteIp);
        const reply = await send(input.verifyUrl, {
          body: form,
          method: "POST",
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        if (!reply.ok) return "unavailable";
        const body: unknown = await reply.json();
        const success =
          typeof body === "object" && body !== null && "success" in body ? body.success : undefined;
        if (success === true) return "verified";
        return success === false ? "rejected" : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
