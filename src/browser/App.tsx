import { useState, useEffect, useRef, useCallback } from "react";
import type {
  Message,
  Part,
  TextPart as SdkTextPart,
  ToolPart as SdkToolPart,
  SessionStatus,
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
  IconRefresh,
  IconSkull,
} from "@tabler/icons-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogLine {
  id: number;
  raw: string;
}

type ConnectionStatus =
  | "idle"
  | "connected"
  | "disconnected"
  | "error"
  | "ended";

interface AgentMessage {
  info: Message;
  parts: Part[];
}

interface Run {
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  commit_sha: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parsePRRoute(): {
  owner: string;
  repo: string;
  prNumber: number;
} | null {
  const match = window.location.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], prNumber: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const pr = parsePRRoute();

  if (!pr) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
        <p className="text-sm">
          Navigate to <code>/:owner/:repo/pull/:number</code> to view a PR.
        </p>
      </div>
    );
  }

  return <PRViewer owner={pr.owner} repo={pr.repo} prNumber={pr.prNumber} />;
}

// ---------------------------------------------------------------------------
// PRViewer
// ---------------------------------------------------------------------------

function PRViewer({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}) {
  // Setup log state (SSE from /stream)
  const [lines, setLines] = useState<LogLine[]>([]);
  const [streamStatus, setStreamStatus] = useState<ConnectionStatus>("idle");
  const [sandboxId, setSandboxId] = useState<string | null>(
    () => window.location.hash.slice(1) || null,
  );
  const [starting, setStarting] = useState(false);

  // Agent messages state (polled from /messages)
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentStatus, setAgentStatus] = useState<SessionStatus | null>(null);

  const logsRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScrollLogsRef = useRef(true);
  const autoScrollMessagesRef = useRef(true);
  const esRef = useRef<EventSource | null>(null);
  const lineIdRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const appendLine = useCallback((raw: string) => {
    const id = lineIdRef.current++;
    setLines((prev) => [...prev, { id, raw }]);
  }, []);

  // -- Setup log SSE connection -----------------------------------------------

  const connectToStream = useCallback(
    (id: string) => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      setLines([]);
      lineIdRef.current = 0;

      const es = new EventSource(`/stream?id=${encodeURIComponent(id)}`);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === "stdout" && payload.data) {
            payload.data
              .split("\n")
              .filter(Boolean)
              .forEach((line: string) => appendLine(line));
          } else if (payload.type === "stderr" && payload.data) {
            appendLine("STDERR: " + payload.data);
          } else if (payload.type === "complete") {
            appendLine(
              "Stream ended (exit code: " + (payload.exitCode ?? "?") + ")",
            );
            setStreamStatus("ended");
            es.close();
          }
        } catch {
          appendLine(e.data);
        }
      };

      es.onopen = () => setStreamStatus("connected");

      es.onerror = () => {
        setStreamStatus("error");
        es.close();
        appendLine("Connection lost. Reconnecting in 3s...");
        setTimeout(() => connectToStream(id), 3000);
      };
    },
    [appendLine],
  );

  // -- Agent messages polling -------------------------------------------------

  const startPolling = useCallback((id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);

    const poll = async () => {
      try {
        const res = await fetch(`/messages?id=${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = await res.json();
        setAgentMessages(data.messages ?? []);
        setAgentStatus(data.status ?? null);
      } catch {
        // Transient -- next poll will retry
      }
    };

    poll();
    pollRef.current = setInterval(poll, 500);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Stop polling when agent goes idle
  useEffect(() => {
    if (agentStatus?.type === "idle" && agentMessages.length > 0) {
      // Do one final poll then stop
      if (sandboxId) {
        fetch(`/messages?id=${encodeURIComponent(sandboxId)}`)
          .then((r) => r.json())
          .then((data) => {
            setAgentMessages(data.messages ?? []);
            setAgentStatus(data.status ?? null);
          })
          .catch(() => {});
      }
      stopPolling();
    }
  }, [agentStatus, agentMessages.length, sandboxId, stopPolling]);

  // -- Lifecycle --------------------------------------------------------------

  const connectToSandbox = useCallback(
    (id: string) => {
      setSandboxId(id);
      window.location.hash = id;
      setAgentMessages([]);
      setAgentStatus(null);
      connectToStream(id);
      startPolling(id);
    },
    [connectToStream, startPolling],
  );

  useEffect(() => {
    if (sandboxId) {
      connectToSandbox(sandboxId);
    }
    return () => {
      esRef.current?.close();
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll logs panel
  useEffect(() => {
    if (autoScrollLogsRef.current && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [lines]);

  // Auto-scroll messages panel
  useEffect(() => {
    if (autoScrollMessagesRef.current && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [agentMessages]);

  function handleLogsScroll() {
    if (!logsRef.current) return;
    const el = logsRef.current;
    autoScrollLogsRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function handleMessagesScroll() {
    if (!messagesRef.current) return;
    const el = messagesRef.current;
    autoScrollMessagesRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function handleStart() {
    setStarting(true);
    try {
      const res = await fetch("/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pr: prNumber }),
      });
      const data = await res.json();

      if (!res.ok) {
        appendLine("ERROR: Start failed -- " + (data.error || res.statusText));
        return;
      }

      connectToSandbox(data.sandboxId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLine("ERROR: Start failed -- " + msg);
    } finally {
      setStarting(false);
    }
  }

  // -- Render -----------------------------------------------------------------

  const agentBusy = agentStatus?.type === "busy";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-950 font-sans antialiased text-gray-300">
      <header className="flex items-center gap-3 border-b border-gray-800 px-6 py-4">
        <h1 className="text-sm font-semibold text-white">
          {owner}/{repo}
        </h1>
        <span className="rounded-full bg-blue-600 px-2.5 py-0.5 text-xs font-medium text-white">
          PR #{prNumber}
        </span>
        {sandboxId && (
          <span className="font-mono text-xs text-gray-600">
            {sandboxId.slice(0, 8)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={handleStart}
            disabled={starting}
            className="flex items-center gap-1.5 rounded-md border border-blue-500 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconPlayerPlay size={14} />
            )}
            {starting ? "Starting..." : sandboxId ? "Restart run" : "Start run"}
          </button>
          <StatusBadge streamStatus={streamStatus} agentBusy={agentBusy} />
        </div>
      </header>

      <RunsPanel
        owner={owner}
        repo={repo}
        prNumber={prNumber}
        activeSandboxId={sandboxId}
        onSelectRun={connectToSandbox}
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] overflow-hidden">
        {/* Left: Setup logs */}
        <div
          ref={logsRef}
          onScroll={handleLogsScroll}
          className="overflow-y-auto border-r border-gray-800 px-4 py-4"
        >
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Logs
          </h2>
          {lines.length === 0 ? (
            <div className="text-xs text-gray-600">No logs yet.</div>
          ) : (
            <div className="space-y-0.5 font-mono text-[12px] leading-relaxed">
              {lines.map((line) => (
                <SetupLogEntry key={line.id} raw={line.raw} />
              ))}
            </div>
          )}
        </div>

        {/* Right: Agent messages */}
        <div
          ref={messagesRef}
          onScroll={handleMessagesScroll}
          className="overflow-y-auto px-4 py-4"
        >
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Agent
          </h2>
          {agentMessages.length === 0 && lines.length === 0 && (
            <div className="text-gray-600">Click "Start run" to begin.</div>
          )}
          {agentMessages.length === 0 &&
            lines.length > 0 &&
            !agentBusy &&
            agentStatus === null && (
              <div className="text-sm text-gray-500">
                Waiting for agent to start...
              </div>
            )}
          <div className="space-y-1">
            {agentMessages.map((msg) => (
              <MessageParts key={msg.info.id} message={msg} />
            ))}
          </div>

          {agentBusy && (
            <div className="mt-3 text-sm text-amber-400">
              Agent is working...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({
  streamStatus,
  agentBusy,
}: {
  streamStatus: ConnectionStatus;
  agentBusy: boolean;
}) {
  if (agentBusy) {
    return (
      <>
        <span className="text-xs text-amber-400">Agent running</span>
        <span className="size-2 animate-pulse rounded-full bg-amber-500" />
      </>
    );
  }

  const config: Record<
    ConnectionStatus,
    { dot: string; label: string; text: string }
  > = {
    connected: {
      dot: "bg-green-500",
      label: "Connected",
      text: "text-green-500",
    },
    disconnected: {
      dot: "bg-gray-600",
      label: "Disconnected",
      text: "text-gray-500",
    },
    idle: { dot: "bg-gray-600", label: "Idle", text: "text-gray-500" },
    error: {
      dot: "bg-red-500",
      label: "Reconnecting...",
      text: "text-red-400",
    },
    ended: { dot: "bg-gray-600", label: "Done", text: "text-gray-500" },
  };

  const s = config[streamStatus];

  return (
    <>
      <span className={`text-xs ${s.text}`}>{s.label}</span>
      <span className={`size-2 rounded-full ${s.dot}`} title={s.label} />
    </>
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
  owner,
  repo,
  prNumber,
  activeSandboxId,
  onSelectRun,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  activeSandboxId: string | null;
  onSelectRun: (id: string) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [killingIds, setKillingIds] = useState<Set<string>>(new Set());
  const [killingAll, setKillingAll] = useState(false);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(
        `/runs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&pr=${prNumber}`,
      );
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs ?? []);
      }
    } catch {
      // Transient
    } finally {
      setLoading(false);
    }
  }, [owner, repo, prNumber]);

  const handleKill = useCallback(
    async (runId: string) => {
      setKillingIds((prev) => new Set(prev).add(runId));
      try {
        await fetch("/runs/kill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runs: [runId] }),
        });
        await fetchRuns();
      } finally {
        setKillingIds((prev) => {
          const next = new Set(prev);
          next.delete(runId);
          return next;
        });
      }
    },
    [fetchRuns],
  );

  const handleKillAll = useCallback(async () => {
    setKillingAll(true);
    try {
      await fetch("/runs/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await fetchRuns();
    } finally {
      setKillingAll(false);
    }
  }, [fetchRuns]);

  useEffect(() => {
    fetchRuns();
    const interval = setInterval(fetchRuns, 5_000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  if (loading && runs.length === 0) {
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

  return (
    <div className="border-b border-gray-800 px-6 py-3">
      <div className="mb-2 flex items-center gap-2">
        <IconGitPullRequest size={14} className="text-gray-500" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Runs
        </h2>
        {runs.some((r) => r.status === "queued" || r.status === "running") && (
          <button
            onClick={handleKillAll}
            disabled={killingAll}
            className="ml-auto flex items-center gap-1 rounded border border-red-900/50 px-2 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:border-red-700 hover:bg-red-950/40 disabled:opacity-50"
            title="Kill all active runs"
          >
            {killingAll ? (
              <IconLoader2 size={12} className="animate-spin" />
            ) : (
              <IconSkull size={12} />
            )}
            Kill all
          </button>
        )}
        <button
          onClick={fetchRuns}
          className={`${runs.some((r) => r.status === "queued" || r.status === "running") ? "" : "ml-auto "}text-gray-600 transition-colors hover:text-gray-400`}
          title="Refresh"
        >
          <IconRefresh size={14} />
        </button>
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
                    handleKill(run.id);
                  }}
                  disabled={isKilling}
                  className="ml-1 rounded p-1 text-gray-600 transition-colors hover:bg-red-950/60 hover:text-red-400 disabled:opacity-50"
                  title="Kill run"
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
