import { useState } from "react";
import { freshLinkOpener, type FreshLinkDisposition, type PresignedUrl } from "../presigned.ts";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { describeProblem } from "./section-boundary.tsx";

/**
 * Mints a short-lived https link on click. `view` opens it in a tab opened inside the click;
 * `download` hands it to the current page, which stays put because the link is an attachment.
 */
export function FreshLinkButton({
  disabled = false,
  disposition,
  label,
  mint,
}: Readonly<{
  disabled?: boolean | undefined;
  disposition: FreshLinkDisposition;
  label: string;
  mint: () => Promise<PresignedUrl>;
}>) {
  const [minting, setMinting] = useState(false);
  const [openLink] = useState(() =>
    freshLinkOpener(
      {
        download: (url) => window.location.assign(url),
        openTab: () => window.open("", "_blank"),
      },
      setMinting,
    ),
  );

  async function open() {
    const outcome = await openLink(disposition, mint);
    if (outcome.kind === "blocked") {
      toast.error("The browser blocked the new tab", {
        description: "Allow pop-ups for the console, then try again.",
      });
    } else if (outcome.kind === "failed") {
      const problem = describeProblem(outcome.error, "The link could not be created");
      toast.error(problem.title, problem.description ? { description: problem.description } : {});
    }
  }

  return (
    <Button disabled={disabled || minting} onClick={() => void open()} variant="outline">
      {label}
    </Button>
  );
}
