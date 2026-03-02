import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconTerminal2 } from "@tabler/icons-react";
import type { SandboxDebugData } from "@/api";
import { cn } from "@/lib/utils";

export function SandboxDebugPanel({
  data,
  isLoading,
}: {
  data: SandboxDebugData | undefined;
  isLoading: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  if (!data && !isLoading) return null;

  return (
    <div className="border-t border-border bg-card/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/30"
      >
        {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <IconTerminal2 size={14} />
        Sandbox Debug
        {data?.processes?.processes && (
          <span className="text-muted-foreground/60">
            ({data.processes.processes.length} processes)
          </span>
        )}
      </button>

      {expanded && (
        <div className="max-h-[300px] overflow-auto border-t border-border/50 p-4 text-xs">
          {isLoading && !data && (
            <div className="text-muted-foreground">Loading...</div>
          )}

          {data?.error && (
            <div className="mb-4 rounded bg-destructive/10 p-2 text-destructive">
              Error: {data.error}
              {data.detail && <span className="block mt-1 opacity-70">{data.detail}</span>}
            </div>
          )}

          {data?.processes?.processes && (
            <Section title="Running Processes">
              <div className="space-y-1">
                {data.processes.processes.map((proc) => (
                  <div key={proc.id} className="flex items-center gap-2 font-mono">
                    <span className={cn(
                      "inline-block w-16 rounded px-1 text-center",
                      proc.status === "running" ? "bg-green-500/20 text-green-400" : "bg-muted"
                    )}>
                      {proc.status}
                    </span>
                    <span className="text-muted-foreground">{proc.pid}</span>
                    <span className="truncate">{proc.command}</span>
                  </div>
                ))}
                {data.processes.processes.length === 0 && (
                  <div className="text-muted-foreground">No processes running</div>
                )}
              </div>
            </Section>
          )}

          {data?.agentLog && (
            <Section title="Agent Log (/workspace/agent.log)">
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                {data.agentLog}
              </pre>
            </Section>
          )}

          {data?.sessionFile && (
            <Section title="Session File (/workspace/opencode-session.json)">
              <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground bg-muted/30 p-2 rounded">
                {data.sessionFile}
              </pre>
            </Section>
          )}

          {data?.psAux && (
            <Section title="Running Processes (ps aux)">
              <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground max-h-[200px] overflow-auto bg-muted/30 p-2 rounded">
                {data.psAux}
              </pre>
            </Section>
          )}

          {data?.opencodeDir && (
            <Section title="OpenCode Directory (/workspace/.opencode/)">
              <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                {data.opencodeDir}
              </pre>
            </Section>
          )}

          {data?.findOpencode && data.findOpencode !== "[find failed]" && (
            <Section title="OpenCode Files (find)">
              <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground max-h-[150px] overflow-auto">
                {data.findOpencode}
              </pre>
            </Section>
          )}

          {data?.processLogs && Object.keys(data.processLogs).length > 0 && (
            <Section title="Process Logs">
              {Object.entries(data.processLogs).map(([procId, logs]) => (
                <div key={procId} className="mb-2">
                  <div className="font-medium text-foreground/80 mb-1">
                    Process {procId.slice(0, 8)}
                  </div>
                  {logs.stdout && (
                    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground bg-muted/30 p-2 rounded mb-1">
                      {logs.stdout}
                    </pre>
                  )}
                  {logs.stderr && (
                    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-red-400/80 bg-red-500/10 p-2 rounded">
                      {logs.stderr}
                    </pre>
                  )}
                </div>
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-2 font-medium text-foreground/80">{title}</h3>
      {children}
    </div>
  );
}
