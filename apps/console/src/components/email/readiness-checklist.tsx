import { AlertCircleIcon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useInstallCopy, type InstallCopy } from "../../edition.ts";
import { VERIFIED_RECIPIENTS_ONLY, type ReadinessCheck } from "../../email/setup-state.ts";
import { Subheading } from "@/components/ui/heading";
import { TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";

const STEP_TITLES: Readonly<Record<ReadinessCheck["step"], string>> = {
  domain: "Verified domain",
  placement: "Default sending placement",
  policy: "Sending policy",
};

function describe(check: ReadinessCheck, emailPath: string, copy: InstallCopy): ReactNode {
  switch (check.step) {
    case "domain":
      if (check.ok) {
        return `${check.verified} of ${check.total} ${check.total === 1 ? "domain is" : "domains are"} verified.`;
      }
      return check.total === 0 ? (
        `No domain yet. Creating the first inbox sets up ${copy.hostedEmailDomain}.`
      ) : (
        <>
          No domain is verified. Finish DNS on the{" "}
          <TextLink href={`${emailPath}/domains`}>Domains</TextLink> tab.
        </>
      );
    case "placement": {
      if (check.ok) return "One active default placement routes outbound mail.";
      const fix = <TextLink href={`${emailPath}/placements`}>Placements</TextLink>;
      if (check.defaults === 0) {
        return <>No default placement. An owner or admin creates one on the {fix} tab.</>;
      }
      if (check.defaults > 1) {
        return (
          <>
            {check.defaults} placements are marked default; exactly one may be. Fix it on the {fix}{" "}
            tab.
          </>
        );
      }
      return <>The default placement is not active yet. Check it on the {fix} tab.</>;
    }
    case "policy": {
      if (check.policy.kind === "defaults") {
        return "No policy is saved, so the defaults apply: sending is allowed, but a new environment sends only to its own inboxes and to allowlisted addresses until its sending volume ramps up.";
      }
      const { sendingStatus, sendingStatusReason, warmupStage } = check.policy.policy;
      if (sendingStatus !== "active") {
        return `Sending is ${sendingStatus}${sendingStatusReason ? `: ${sendingStatusReason}` : "."}`;
      }
      return VERIFIED_RECIPIENTS_ONLY[warmupStage]
        ? "Sending is allowed, but only to the environment's own inboxes and to allowlisted or verified addresses until its sending volume ramps up."
        : "Sending is allowed.";
    }
    default: {
      const exhaustive: never = check;
      return exhaustive;
    }
  }
}

export function ReadinessChecklist({
  checks,
  emailPath,
}: Readonly<{ checks: readonly ReadinessCheck[]; emailPath: string }>) {
  const copy = useInstallCopy();
  // Where the service provides sending, the customer has no placement to create.
  const shown = checks.filter((check) => copy.managesEmailSending || check.step !== "placement");
  const ready = shown.every((check) => check.ok);
  return (
    <section className="flex flex-col gap-3" aria-label="Sending readiness">
      <Subheading>{ready ? "Ready to send" : "Not ready to send"}</Subheading>
      <ol className="flex flex-col gap-3">
        {shown.map((check) => (
          <li className="flex gap-3 text-sm/6" key={check.step}>
            <Icon
              className={check.ok ? "mt-1 size-4 text-green-600" : "mt-1 size-4 text-amber-600"}
              icon={check.ok ? CheckmarkCircle02Icon : AlertCircleIcon}
            />
            <div>
              <div className="font-medium text-foreground">{STEP_TITLES[check.step]}</div>
              <div className="text-muted-foreground">{describe(check, emailPath, copy)}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
