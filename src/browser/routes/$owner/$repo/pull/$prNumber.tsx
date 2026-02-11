import { useState, useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  IconPlayerPlay,
  IconLoader2,
  IconGitPullRequest,
  IconExternalLink,
} from "@tabler/icons-react";
import {
  useRuns,
  useLogs,
  useMessages,
  useStartRun,
  useKillRun,
  useKillAllRuns,
} from "@/api";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RunsPanel } from "@/components/runs-panel";
import { SetupLogEntry, SectionDivider } from "@/components/log-entry";
import { MessageParts } from "@/components/message-parts";

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/$owner/$repo/pull/$prNumber")({
  component: PRViewer,
  parseParams: (params) => ({
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    sandbox: (search.sandbox as string) || undefined,
  }),
});

// ---------------------------------------------------------------------------
// PRViewer
// ---------------------------------------------------------------------------

function PRViewer() {
  const { owner, repo, prNumber } = Route.useParams();
  const { sandbox } = Route.useSearch();
  const navigate = Route.useNavigate();
  const pr = Number(prNumber);

  const [sandboxId, setSandboxId] = useState<string | null>(sandbox ?? null);

  // Sync sandboxId to URL search param
  function selectSandbox(id: string) {
    setSandboxId(id);
    navigate({
      search: { sandbox: id },
      replace: true,
    });
  }

  // Query hooks
  const { data: runs = [], isLoading: runsLoading } = useRuns(owner, repo, pr);
  const { data: lines = [] } = useLogs(sandboxId);
  const { data: messagesData } = useMessages(sandboxId);
  const startRun = useStartRun(owner, repo, pr);
  const killRun = useKillRun(owner, repo, pr);
  const killAll = useKillAllRuns(owner, repo, pr);

  const agentMessages = messagesData?.messages ?? [];
  const agentStatus = messagesData?.status ?? null;
  const agentBusy = agentStatus?.type === "busy";

  // Refs for auto-scroll
  const timelineRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevContentLenRef = useRef(0);

  const contentLen = lines.length + agentMessages.length;
  useEffect(() => {
    if (contentLen > prevContentLenRef.current) {
      if (autoScrollRef.current && timelineRef.current) {
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
      }
    }
    prevContentLenRef.current = contentLen;
  }, [contentLen]);

  function handleTimelineScroll() {
    if (!timelineRef.current) return;
    const el = timelineRef.current;
    autoScrollRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  // Split logs into start/end phases using markers
  const agentStartIdx = lines.findIndex((l) =>
    l.includes("--- AGENT_START ---"),
  );
  const agentEndIdx = lines.findIndex((l) => l.includes("--- AGENT_END ---"));
  const agentStarted = agentStartIdx >= 0;
  const agentEnded = agentEndIdx >= 0;
  const startLogs = agentStarted ? lines.slice(0, agentStartIdx) : lines;
  const endLogs = agentEnded ? lines.slice(agentEndIdx + 1) : [];

  function handleStart() {
    startRun.mutate(undefined, {
      onSuccess: (data) => {
        selectSandbox(data.sandboxId);
      },
    });
  }

  const activeRuns = runs.filter(
    (r) => r.status === "queued" || r.status === "running",
  );
  const latestCommit = runs.length > 0 ? runs[0].commit_sha : null;
  const ghUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background font-sans antialiased text-foreground">
      <header className="border-b border-border px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <IconGitPullRequest size={18} className="text-green-400" />
            <div>
              <h1 className="text-sm font-semibold leading-tight">
                {owner}/{repo}{" "}
                <span className="text-muted-foreground">#{prNumber}</span>
              </h1>
              <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground/60">
                {latestCommit && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <a
                          href={`https://github.com/${owner}/${repo}/commit/${latestCommit}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono hover:text-foreground"
                        />
                      }
                    >
                      {latestCommit.slice(0, 7)}
                    </TooltipTrigger>
                    <TooltipContent>{latestCommit}</TooltipContent>
                  </Tooltip>
                )}
                {activeRuns.length > 0 && (
                  <span className="text-amber-400">
                    {activeRuns.length} active
                  </span>
                )}
                {sandboxId && (
                  <Tooltip>
                    <TooltipTrigger className="cursor-default">
                      viewing{" "}
                      <span className="font-mono">{sandboxId.slice(0, 8)}</span>
                    </TooltipTrigger>
                    <TooltipContent>{sandboxId}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={ghUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <IconExternalLink size={12} />
              GitHub
            </a>
            <Button
              onClick={handleStart}
              disabled={startRun.isPending}
              size="sm"
            >
              {startRun.isPending ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconPlayerPlay size={14} />
              )}
              {startRun.isPending ? "Starting..." : "New run"}
            </Button>
          </div>
        </div>
      </header>

      <RunsPanel
        runs={runs}
        runsLoading={runsLoading}
        activeSandboxId={sandboxId}
        onSelectRun={selectSandbox}
        onKillRun={(id) => killRun.mutate(id)}
        killingIds={
          killRun.isPending ? new Set([killRun.variables]) : new Set()
        }
        onKillAll={() => killAll.mutate()}
        killingAll={killAll.isPending}
      />

      <ScrollArea
        viewportRef={timelineRef}
        onScroll={handleTimelineScroll}
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
    </div>
  );
}
