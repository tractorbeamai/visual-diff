import { useState, useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type {
  Part,
  TextPart as SdkTextPart,
  ToolPart as SdkToolPart,
} from "@opencode-ai/sdk";
import {
  IconPlayerPlay,
  IconLoader2,
  IconCircleCheck,
  IconCircleX,
  IconBan,
  IconClock,
  IconBox,
  IconGitPullRequest,
  IconSkull,
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
import type { Run, AgentMessage } from "@/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import type React from "react";
import { cn } from "@/lib/utils";

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
                  <a
                    href={`https://github.com/${owner}/${repo}/commit/${latestCommit}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono hover:text-foreground"
                  >
                    {latestCommit.slice(0, 7)}
                  </a>
                )}
                {activeRuns.length > 0 && (
                  <span className="text-amber-400">
                    {activeRuns.length} active
                  </span>
                )}
                {sandboxId && (
                  <span>
                    viewing{" "}
                    <span className="font-mono">{sandboxId.slice(0, 8)}</span>
                  </span>
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

      <div
        ref={timelineRef}
        onScroll={handleTimelineScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto max-w-3xl space-y-4">
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup log entry
// ---------------------------------------------------------------------------

function SetupLogEntry({ raw }: { raw: string }) {
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)$/);

  if (match) {
    const timestamp = new Date(match[1]).toLocaleTimeString();
    const message = match[2];

    let cls = "text-muted-foreground";
    if (message.startsWith("ERROR")) cls = "text-destructive";
    else if (message.startsWith("Done")) cls = "font-semibold text-green-400";

    return (
      <div className="flex gap-3">
        <span className="shrink-0 tabular-nums text-muted-foreground/50">
          {timestamp}
        </span>
        <span className={cls}>{message}</span>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span className="text-muted-foreground">{raw}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section divider
// ---------------------------------------------------------------------------

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Separator className="flex-1" />
      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/40">
        {label}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent message rendering
// ---------------------------------------------------------------------------

function MessageParts({ message }: { message: AgentMessage }) {
  const { info, parts } = message;
  const isAssistant = info.role === "assistant";

  return (
    <div className="space-y-2">
      {parts.map((part, i) => (
        <PartView key={i} part={part} isAssistant={isAssistant} />
      ))}
    </div>
  );
}

function PartView({ part, isAssistant }: { part: Part; isAssistant: boolean }) {
  switch (part.type) {
    case "text":
      return (
        <TextPartView
          text={(part as SdkTextPart).text}
          isAssistant={isAssistant}
        />
      );
    case "tool":
      return <ToolPartView part={part as SdkToolPart} />;
    case "step-start":
      return <Separator className="my-2 opacity-20" />;
    default:
      return null;
  }
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match bold, inline code, or plain text
  const pattern = /(\*\*(.+?)\*\*|`([^`]+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(
        <strong key={match.index} className="font-semibold">
          {match[2]}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(
        <code
          key={match.index}
          className="bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]"
        >
          {match[3]}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function SimpleMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre
          key={`code-${i}`}
          className="overflow-x-auto bg-muted/50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground/80"
        >
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // Headings
    if (line.startsWith("## ")) {
      elements.push(
        <h3
          key={`h-${i}`}
          className="mt-3 mb-1 text-sm font-semibold text-foreground"
        >
          {renderInlineMarkdown(line.slice(3))}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(
        <h2
          key={`h-${i}`}
          className="mt-3 mb-1 text-base font-semibold text-foreground"
        >
          {renderInlineMarkdown(line.slice(2))}
        </h2>,
      );
      i++;
      continue;
    }

    // List items
    if (line.match(/^[-*]\s/)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        listItems.push(
          <li key={`li-${i}`}>
            {renderInlineMarkdown(lines[i].replace(/^[-*]\s/, ""))}
          </li>,
        );
        i++;
      }
      elements.push(
        <ul
          key={`ul-${i}`}
          className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed"
        >
          {listItems}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s/)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        listItems.push(
          <li key={`li-${i}`}>
            {renderInlineMarkdown(lines[i].replace(/^\d+\.\s/, ""))}
          </li>,
        );
        i++;
      }
      elements.push(
        <ol
          key={`ol-${i}`}
          className="list-decimal space-y-0.5 pl-5 text-sm leading-relaxed"
        >
          {listItems}
        </ol>,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${i}`} className="text-sm leading-relaxed">
        {renderInlineMarkdown(line)}
      </p>,
    );
    i++;
  }

  return <div className={cn("space-y-2", className)}>{elements}</div>;
}

function TextPartView({
  text,
  isAssistant,
}: {
  text: string;
  isAssistant: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <SimpleMarkdown
      text={text}
      className={isAssistant ? "text-foreground" : "text-muted-foreground"}
    />
  );
}

// ---------------------------------------------------------------------------
// Runs panel
// ---------------------------------------------------------------------------

function RunStatusIcon({ status }: { status: Run["status"] }) {
  switch (status) {
    case "queued":
      return <IconClock size={16} className="text-muted-foreground" />;
    case "running":
      return <IconLoader2 size={16} className="animate-spin text-amber-400" />;
    case "completed":
      return <IconCircleCheck size={16} className="text-green-400" />;
    case "failed":
      return <IconCircleX size={16} className="text-destructive" />;
    case "cancelled":
      return <IconBan size={16} className="text-muted-foreground/50" />;
  }
}

const statusConfig: Record<
  Run["status"],
  {
    label: string;
    variant: "secondary" | "outline" | "default" | "destructive";
  }
> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "outline" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

function StatusBadge({ status }: { status: Run["status"] }) {
  const { label, variant } = statusConfig[status];
  return (
    <Badge variant={variant} className="text-xs">
      {label}
    </Badge>
  );
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr + "Z").getTime()) / 1000,
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function RunsPanel({
  runs,
  runsLoading,
  activeSandboxId,
  onSelectRun,
  onKillRun,
  killingIds,
  onKillAll,
  killingAll,
}: {
  runs: Run[];
  runsLoading: boolean;
  activeSandboxId: string | null;
  onSelectRun: (id: string) => void;
  onKillRun: (id: string) => void;
  killingIds: Set<string | undefined>;
  onKillAll: () => void;
  killingAll: boolean;
}) {
  if (runsLoading && runs.length === 0) {
    return (
      <div className="border-b border-border px-6 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <IconLoader2 size={14} className="animate-spin" />
          Loading runs...
        </div>
      </div>
    );
  }

  if (runs.length === 0) return null;

  const hasActive = runs.some(
    (r) => r.status === "queued" || r.status === "running",
  );

  return (
    <div className="border-b border-border px-6 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Runs
        </h2>
        <span className="text-xs text-muted-foreground/50">{runs.length}</span>
        {hasActive && (
          <Button
            onClick={onKillAll}
            disabled={killingAll}
            variant="destructive"
            size="xs"
            className="ml-auto"
          >
            {killingAll ? (
              <IconLoader2 size={12} className="animate-spin" />
            ) : (
              <IconSkull size={12} />
            )}
            Cancel all
          </Button>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {runs.map((run) => {
          const isActive = run.id === activeSandboxId;
          const isKillable =
            run.status === "queued" || run.status === "running";
          const isKilling = killingIds.has(run.id);
          return (
            <button
              key={run.id}
              onClick={() => onSelectRun(run.id)}
              className={cn(
                "flex shrink-0 items-center gap-2.5 border px-3 py-2 text-left text-xs transition-all",
                isActive
                  ? "border-primary/30 bg-primary/5"
                  : "border-border bg-card hover:border-foreground/20 hover:bg-muted/30",
              )}
            >
              <RunStatusIcon status={run.status} />
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-medium text-foreground">
                    {run.commit_sha.slice(0, 7)}
                  </span>
                  <StatusBadge status={run.status} />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                  <span className="flex items-center gap-1">
                    <IconBox size={10} />
                    {run.id.slice(0, 8)}
                  </span>
                  <span>{timeAgo(run.created_at)}</span>
                </div>
              </div>
              {isKillable && (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onKillRun(run.id);
                  }}
                  disabled={isKilling}
                  variant="ghost"
                  size="icon-xs"
                  className="ml-1 text-muted-foreground hover:text-destructive"
                >
                  {isKilling ? (
                    <IconLoader2 size={14} className="animate-spin" />
                  ) : (
                    <IconSkull size={14} />
                  )}
                </Button>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call rendering
// ---------------------------------------------------------------------------

function ToolPartView({ part }: { part: SdkToolPart }) {
  const [expanded, setExpanded] = useState(false);
  const name = part.tool;
  const { state } = part;
  const status = state.status;

  const badgeVariant: Record<
    string,
    "secondary" | "default" | "destructive" | "outline"
  > = {
    pending: "secondary",
    running: "outline",
    completed: "default",
    error: "destructive",
  };

  const title =
    state.status === "running" || state.status === "completed"
      ? state.title
      : undefined;

  const hasInput = state.input && Object.keys(state.input).length > 0;
  const hasOutput = state.status === "completed" && state.output;
  const hasError = state.status === "error" && state.error;
  const hasDetails = hasInput || hasOutput || hasError;

  return (
    <div
      className={cn(
        "border text-xs transition-colors",
        status === "error"
          ? "border-destructive/20 bg-destructive/5"
          : "border-border bg-card",
      )}
    >
      <button
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          hasDetails ? "cursor-pointer hover:bg-muted/30" : "cursor-default",
        )}
      >
        {!!hasDetails && (
          <span
            className={cn(
              "text-[10px] text-muted-foreground/40 transition-transform",
              expanded && "rotate-90",
            )}
          >
            &#9654;
          </span>
        )}
        <span className="font-mono font-medium text-foreground/80">{name}</span>
        {title && (
          <span className="truncate text-muted-foreground/60">{title}</span>
        )}
        <Badge
          variant={badgeVariant[status] ?? "secondary"}
          className="ml-auto text-[10px]"
        >
          {status}
        </Badge>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {hasInput && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40">
                Input
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(state.input, null, 2)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40">
                Output
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
                {state.status === "completed" ? state.output : ""}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-destructive/70">
                Error
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
                {state.status === "error" ? state.error : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
