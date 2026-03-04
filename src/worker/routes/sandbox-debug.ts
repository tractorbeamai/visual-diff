import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import { withTimeout } from "../utils";
import type { Env } from "../types";

const sandboxDebug = new Hono<{ Bindings: Env }>();

sandboxDebug.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  try {
    const [processes, agentLog, opencodeDir, homeLogs, sessionFile, psAux, findOpencode] = await Promise.allSettled([
      withTimeout(sandbox.listProcesses(), 5_000),
      withTimeout(sandbox.exec("cat /workspace/agent.log 2>/dev/null || echo '[no agent.log]'"), 5_000),
      withTimeout(sandbox.exec("ls -laR /workspace/.opencode/ 2>/dev/null || echo '[no .opencode dir]'"), 5_000),
      withTimeout(sandbox.exec("ls -laR ~/.local/share/opencode/ 2>/dev/null || echo '[no home opencode dir]'"), 5_000),
      withTimeout(sandbox.exec("cat /workspace/opencode-session.json 2>/dev/null || echo '[no session file]'"), 5_000),
      withTimeout(sandbox.exec("ps aux 2>/dev/null || echo '[ps failed]'"), 5_000),
      withTimeout(sandbox.exec("find / -name 'opencode*' -o -name '*.opencode*' 2>/dev/null | head -50 || echo '[find failed]'"), 10_000),
    ]);

    const processLogs: Record<string, { stdout: string; stderr: string }> = {};

    if (processes.status === "fulfilled" && processes.value?.processes) {
      for (const proc of processes.value.processes.slice(0, 5)) {
        try {
          const logs = await withTimeout(sandbox.getProcessLogs(proc.id), 3_000);
          processLogs[proc.id] = {
            stdout: logs.stdout?.slice(-2000) ?? "",
            stderr: logs.stderr?.slice(-2000) ?? "",
          };
        } catch {
          processLogs[proc.id] = { stdout: "[failed to get logs]", stderr: "" };
        }
      }
    }

    return c.json({
      processes: processes.status === "fulfilled" ? processes.value : { error: String(processes.reason) },
      agentLog: agentLog.status === "fulfilled" ? agentLog.value.stdout?.slice(-5000) : String(agentLog.reason),
      opencodeDir: opencodeDir.status === "fulfilled" ? opencodeDir.value.stdout : String(opencodeDir.reason),
      homeLogs: homeLogs.status === "fulfilled" ? homeLogs.value.stdout : String(homeLogs.reason),
      sessionFile: sessionFile.status === "fulfilled" ? sessionFile.value.stdout : String(sessionFile.reason),
      psAux: psAux.status === "fulfilled" ? psAux.value.stdout?.slice(-3000) : String(psAux.reason),
      findOpencode: findOpencode.status === "fulfilled" ? findOpencode.value.stdout : String(findOpencode.reason),
      processLogs,
    });
  } catch (err) {
    return c.json({
      error: "sandbox_unreachable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export { sandboxDebug };
