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
  IconBrain,
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
} from "../../../../api";
import type { Run, AgentMessage } from "../../../../api";

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
    <div className="flex h-screen flex-col overflow-hidden bg-gray-950 font-sans antialiased text-gray-300">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <IconGitPullRequest size={20} className="text-green-400" />
              <h1 className="text-base font-semibold text-white">
                {owner}/{repo} #{prNumber}
              </h1>
            </div>
            <a
              href={ghUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300"
            >
              <IconExternalLink size={12} />
              GitHub
            </a>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleStart}
              disabled={startRun.isPending}
              className="flex items-center gap-1.5 rounded-md border border-blue-500 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {startRun.isPending ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconPlayerPlay size={14} />
              )}
              {startRun.isPending ? "Starting..." : "New run"}
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
          {latestCommit && (
            <span>
              Latest commit:{" "}
              <a
                href={`https://github.com/${owner}/${repo}/commit/${latestCommit}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-gray-400 hover:text-gray-200"
              >
                {latestCommit.slice(0, 7)}
              </a>
            </span>
          )}
          <span>
            {runs.length} run{runs.length !== 1 ? "s" : ""}
          </span>
          {activeRuns.length > 0 && (
            <span className="text-amber-400">{activeRuns.length} active</span>
          )}
          {sandboxId && (
            <span>
              Viewing:{" "}
              <span className="font-mono text-gray-400">
                {sandboxId.slice(0, 8)}
              </span>
            </span>
          )}
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
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
      >
        {lines.length === 0 && agentMessages.length === 0 && (
          <div className="text-gray-600">Click "New run" to begin.</div>
        )}

        {startLogs.length > 0 && (
          <div className="space-y-0.5 font-mono text-[12px] leading-relaxed">
            {startLogs.map((line, i) => (
              <SetupLogEntry key={`s-${i}`} raw={line} />
            ))}
          </div>
        )}

        {agentStarted && <SectionDivider label="Agent" />}

        {agentMessages.length === 0 && agentStarted && !agentEnded && (
          <div className="text-sm text-gray-500">
            Waiting for agent messages...
          </div>
        )}

        {agentMessages.length > 0 && (
          <div className="space-y-1">
            {agentMessages.map((msg) => (
              <MessageParts key={msg.info.id} message={msg} />
            ))}
          </div>
        )}

        {agentBusy && (
          <div className="mt-3 text-sm text-amber-400">Agent is working...</div>
        )}

        {agentEnded && <SectionDivider label="Results" />}

        {endLogs.length > 0 && (
          <div className="space-y-0.5 font-mono text-[12px] leading-relaxed">
            {endLogs.map((line, i) => (
              <SetupLogEntry key={`e-${i}`} raw={line} />
            ))}
          </div>
        )}
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

    let cls = "text-gray-400";
    if (message.startsWith("ERROR")) cls = "text-red-400";
    else if (message.startsWith("Done")) cls = "font-semibold text-green-400";
    else if (message.includes("working")) cls = "text-amber-400";

    return (
      <div className="flex gap-3">
        <span className="shrink-0 tabular-nums text-gray-600">{timestamp}</span>
        <span className={cls}>{message}</span>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span className="text-gray-500">{raw}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section divider
// ---------------------------------------------------------------------------

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-gray-800" />
      <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
        {label}
      </span>
      <div className="h-px flex-1 bg-gray-800" />
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
    <div className="space-y-1">
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
      return <div className="border-t border-gray-800/30 my-1" />;
    default:
      return null;
  }
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
    <pre
      className={`whitespace-pre-wrap text-[13px] leading-relaxed ${
        isAssistant ? "text-gray-200" : "text-gray-400"
      }`}
    >
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Runs panel
// ---------------------------------------------------------------------------

function RunStatusIcon({ status }: { status: Run["status"] }) {
  switch (status) {
    case "queued":
      return <IconClock size={16} className="text-gray-400" />;
    case "running":
      return <IconLoader2 size={16} className="animate-spin text-amber-400" />;
    case "completed":
      return <IconCircleCheck size={16} className="text-green-400" />;
    case "failed":
      return <IconCircleX size={16} className="text-red-400" />;
    case "cancelled":
      return <IconBan size={16} className="text-gray-500" />;
  }
}

const statusLabel: Record<Run["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const statusColor: Record<Run["status"], string> = {
  queued: "text-gray-400",
  running: "text-amber-400",
  completed: "text-green-400",
  failed: "text-red-400",
  cancelled: "text-gray-500",
};

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
      <div className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-2 text-xs text-gray-500">
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
    <div className="border-b border-gray-800 px-6 py-3">
      <div className="mb-2 flex items-center gap-2">
        <IconGitPullRequest size={14} className="text-gray-500" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Runs
        </h2>
        {hasActive && (
          <button
            onClick={onKillAll}
            disabled={killingAll}
            className="ml-auto flex items-center gap-1 rounded border border-red-900/50 px-2 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:border-red-700 hover:bg-red-950/40 disabled:opacity-50"
            title="Cancel all active runs"
          >
            {killingAll ? (
              <IconLoader2 size={12} className="animate-spin" />
            ) : (
              <IconSkull size={12} />
            )}
            Cancel all
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {runs.map((run) => {
          const isActive = run.id === activeSandboxId;
          const isKillable =
            run.status === "queued" || run.status === "running";
          const isKilling = killingIds.has(run.id);
          return (
            <div
              key={run.id}
              className={`group flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${
                isActive
                  ? "border-blue-500/40 bg-blue-950/30"
                  : "border-gray-800 bg-gray-900/40 hover:border-gray-700 hover:bg-gray-900/60"
              }`}
            >
              <button
                onClick={() => onSelectRun(run.id)}
                className="flex items-center gap-2 text-left"
              >
                <RunStatusIcon status={run.status} />
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-gray-300">
                      {run.commit_sha.slice(0, 7)}
                    </span>
                    <span
                      className={`text-[10px] font-medium ${statusColor[run.status]}`}
                    >
                      {statusLabel[run.status]}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-gray-600">
                    <span className="flex items-center gap-1">
                      <IconBox size={10} />
                      {run.id.slice(0, 8)}
                    </span>
                    <span className="flex items-center gap-1">
                      <IconBrain size={10} />
                      {timeAgo(run.created_at)}
                    </span>
                  </div>
                </div>
              </button>
              {isKillable && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onKillRun(run.id);
                  }}
                  disabled={isKilling}
                  className="ml-1 rounded p-1 text-gray-600 transition-colors hover:bg-red-950/60 hover:text-red-400 disabled:opacity-50"
                  title="Cancel run"
                >
                  {isKilling ? (
                    <IconLoader2 size={14} className="animate-spin" />
                  ) : (
                    <IconSkull size={14} />
                  )}
                </button>
              )}
            </div>
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

  const statusColors: Record<string, string> = {
    pending: "bg-gray-700 text-gray-400",
    running: "bg-amber-900/60 text-amber-300",
    completed: "bg-green-900/60 text-green-300",
    error: "bg-red-900/60 text-red-300",
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
    <div className="rounded border border-gray-800 bg-gray-900/60 text-[12px]">
      <button
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
          hasDetails ? "cursor-pointer hover:bg-gray-800/40" : "cursor-default"
        }`}
      >
        {!!hasDetails && (
          <span
            className={`text-[10px] text-gray-600 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            &#9654;
          </span>
        )}
        <span className="font-mono font-medium text-gray-300">{name}</span>
        {title && <span className="truncate text-gray-500">{title}</span>}
        <span
          className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors[status] ?? statusColors.pending}`}
        >
          {status}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-gray-800 px-3 py-2">
          {hasInput && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                Input
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-gray-400">
                {JSON.stringify(state.input, null, 2)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                Output
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-gray-400">
                {state.status === "completed" ? state.output : ""}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-red-500">
                Error
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-red-400">
                {state.status === "error" ? state.error : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
