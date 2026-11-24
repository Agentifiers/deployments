import { CliError, ExitCode } from "./errors.ts";
import type { CliIo } from "./types.ts";

export async function interactiveCommand(io: CliIo): Promise<string[]> {
  const prompts = await import("@clack/prompts");
  prompts.intro("deployments");
  const selection = await prompts.select({
    message: "Choose a platform task",
    options: [
      { value: "whoami", label: "Current identity", hint: "whoami" },
      { value: "project-list", label: "List projects", hint: "project list" },
      { value: "agent-list", label: "List agents", hint: "agent list" },
      { value: "chat", label: "Chat with an agent", hint: "chat" },
      { value: "run-tail", label: "Tail a run", hint: "run tail" },
      { value: "usage", label: "Show usage", hint: "usage show" },
      { value: "catalog", label: "Browse every command", hint: "catalog" },
    ],
  });
  if (prompts.isCancel(selection)) throw new CliError("Operation canceled.", ExitCode.canceled);
  if (selection === "whoami") return ["whoami"];
  if (selection === "project-list") return ["project", "list"];
  if (selection === "agent-list") return ["agent", "list"];
  if (selection === "usage") return ["usage", "show"];
  if (selection === "catalog") return ["catalog"];
  if (selection === "run-tail") {
    const runId = await prompts.text({ message: "Run ID", placeholder: "run_..." });
    if (prompts.isCancel(runId)) throw new CliError("Operation canceled.", ExitCode.canceled);
    const threadId = await prompts.text({ message: "Thread ID", placeholder: "thread_..." });
    if (prompts.isCancel(threadId)) throw new CliError("Operation canceled.", ExitCode.canceled);
    return ["run", "tail", String(runId), "--thread", String(threadId)];
  }
  const agent = await prompts.text({
    message: "Agent deployment ID",
    placeholder: "deployment_...",
  });
  if (prompts.isCancel(agent)) throw new CliError("Operation canceled.", ExitCode.canceled);
  const message = await prompts.text({ message: "Message" });
  if (prompts.isCancel(message)) throw new CliError("Operation canceled.", ExitCode.canceled);
  io.stdout("");
  return ["chat", "--agent", String(agent), "--message", String(message)];
}
