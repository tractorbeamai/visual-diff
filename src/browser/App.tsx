import { useState, useEffect, useRef, useCallback } from "react";

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

function PRViewer({
  owner,
  repo,
  prNumber,
}: {
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sandboxId, setSandboxId] = useState<string | null>(
    () => window.location.hash.slice(1) || null,
  );
  const [starting, setStarting] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const esRef = useRef<EventSource | null>(null);
  const lineIdRef = useRef(0);

  const appendLine = useCallback((raw: string) => {
    const id = lineIdRef.current++;
    setLines((prev) => [...prev, { id, raw }]);
  }, []);

  const connectToSandbox = useCallback(
    (id: string) => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      setSandboxId(id);
      window.location.hash = id;
      setLines([]);
      lineIdRef.current = 0;
      appendLine("Connecting to agent stream...");

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
            setStatus("ended");
            es.close();
          }
        } catch {
          appendLine(e.data);
        }
      };

      es.onopen = () => setStatus("connected");

      es.onerror = () => {
        setStatus("error");
        es.close();
        appendLine("Connection lost. Reconnecting in 3s...");
        setTimeout(() => connectToSandbox(id), 3000);
      };
    },
    [appendLine],
  );

  // Connect on mount if sandbox ID is in the hash
  useEffect(() => {
    if (sandboxId) {
      connectToSandbox(sandboxId);
    }
    return () => {
      esRef.current?.close();
    };
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (autoScrollRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  function handleScroll() {
    if (!logRef.current) return;
    const el = logRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
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

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 font-sans antialiased text-gray-300">
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
            className="rounded-md border border-blue-500 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? "Starting..." : sandboxId ? "Restart run" : "Start run"}
          </button>
          <StatusIndicator status={status} />
        </div>
      </header>

      <div
        ref={logRef}
        onScroll={handleScroll}
        className="flex-1 space-y-0.5 overflow-y-auto px-6 py-4 font-mono text-[13px] leading-relaxed"
      >
        {lines.length === 0 && (
          <div className="text-gray-600">Click "Start run" to begin.</div>
        )}
        {lines.map((line) => (
          <LogEntry key={line.id} raw={line.raw} />
        ))}
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: ConnectionStatus }) {
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
    ended: {
      dot: "bg-gray-600",
      label: "Stream ended",
      text: "text-gray-500",
    },
  };

  const s = config[status];

  return (
    <>
      <span className={`text-xs ${s.text}`}>{s.label}</span>
      <span
        className={`size-2 rounded-full ${s.dot}`}
        title={s.label}
      />
    </>
  );
}

function LogEntry({ raw }: { raw: string }) {
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)$/);

  if (match) {
    const timestamp = new Date(match[1]).toLocaleTimeString();
    const message = match[2];

    let messageClass = "text-gray-300";
    if (message.startsWith("ERROR")) messageClass = "text-red-400";
    else if (message.startsWith("Done"))
      messageClass = "font-semibold text-green-400";
    else if (message.includes("working") || message.includes("Still working"))
      messageClass = "text-amber-400";

    return (
      <div className="flex gap-3">
        <span className="shrink-0 tabular-nums text-gray-600">{timestamp}</span>
        <span className={messageClass}>{message}</span>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span className="text-gray-400">{raw}</span>
    </div>
  );
}
