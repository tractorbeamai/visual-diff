import { IconLoader2 } from "@tabler/icons-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SetupLogEntry, SectionDivider } from "@/components/log-entry";
import { MessageParts } from "@/components/message-parts";
import type { AgentMessage } from "@/api";

export function PRTimeline({
  lines,
  agentMessages,
  agentBusy,
  viewportRef,
  onScroll,
}: {
  lines: string[];
  agentMessages: AgentMessage[];
  agentBusy: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  const agentStartIdx = lines.findIndex((l) =>
    l.includes("--- AGENT_START ---"),
  );
  const agentEndIdx = lines.findIndex((l) => l.includes("--- AGENT_END ---"));
  const agentStarted = agentStartIdx >= 0;
  const agentEnded = agentEndIdx >= 0;
  const startLogs = agentStarted ? lines.slice(0, agentStartIdx) : lines;
  const endLogs = agentEnded ? lines.slice(agentEndIdx + 1) : [];

  return (
    <ScrollArea
      viewportRef={viewportRef}
      onScroll={onScroll}
      className="min-h-0 flex-1"
    >
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
        {lines.length === 0 && agentMessages.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Click &ldquo;New run&rdquo; to begin.
          </div>
        )}

        {startLogs.length > 0 && (
          <div className="space-y-0.5 font-mono text-xs leading-relaxed">
            {startLogs.map((line, i) => (
              <SetupLogEntry key={`s-${i}`} raw={line} />
            ))}
          </div>
        )}

        {agentStarted && <SectionDivider label="Agent" />}

        {agentMessages.length === 0 && agentStarted && !agentEnded && (
          <div className="text-sm text-muted-foreground">
            Waiting for agent messages...
          </div>
        )}

        {agentMessages.length > 0 && (
          <div className="space-y-3">
            {agentMessages.map((msg) => (
              <MessageParts key={msg.info.id} message={msg} />
            ))}
          </div>
        )}

        {agentBusy && !agentEnded && (
          <div className="flex items-center gap-2 py-2 text-sm text-amber-400">
            <IconLoader2 size={14} className="animate-spin" />
            Agent is working...
          </div>
        )}

        {agentEnded && <SectionDivider label="Results" />}

        {endLogs.length > 0 && (
          <div className="space-y-0.5 font-mono text-xs leading-relaxed">
            {endLogs.map((line, i) => (
              <SetupLogEntry key={`e-${i}`} raw={line} />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
