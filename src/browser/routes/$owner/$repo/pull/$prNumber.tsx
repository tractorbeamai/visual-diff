import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  useRuns,
  useLogs,
  useMessages,
  useStartRun,
  useKillRun,
  useKillAllRuns,
} from "@/api";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { PRHeader } from "@/components/pr-header";
import { PRTimeline } from "@/components/pr-timeline";
import { RunsPanel } from "@/components/runs-panel";

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

function PRViewer() {
  const { owner, repo, prNumber } = Route.useParams();
  const { sandbox } = Route.useSearch();
  const navigate = Route.useNavigate();
  const pr = Number(prNumber);

  const [sandboxId, setSandboxId] = useState<string | null>(sandbox ?? null);

  function selectSandbox(id: string) {
    setSandboxId(id);
    navigate({ search: { sandbox: id }, replace: true });
  }

  const { data: runs = [], isLoading: runsLoading } = useRuns(owner, repo, pr);
  const { data: lines = [] } = useLogs(sandboxId);
  const { data: messagesData } = useMessages(sandboxId);
  const startRun = useStartRun(owner, repo, pr);
  const killRun = useKillRun(owner, repo, pr);
  const killAll = useKillAllRuns(owner, repo, pr);

  const agentMessages = messagesData?.messages ?? [];
  const agentStatus = messagesData?.status ?? null;

  const { viewportRef, handleScroll } = useAutoScroll(
    lines.length + agentMessages.length,
  );

  const activeRuns = runs.filter(
    (r) => r.status === "queued" || r.status === "running",
  );

  function handleStart() {
    startRun.mutate(undefined, {
      onSuccess: (data) => selectSandbox(data.sandboxId),
    });
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background font-sans antialiased text-foreground">
      <PRHeader
        owner={owner}
        repo={repo}
        prNumber={prNumber}
        latestCommit={runs.length > 0 ? runs[0].commit_sha : null}
        activeRunCount={activeRuns.length}
        sandboxId={sandboxId}
        onStart={handleStart}
        starting={startRun.isPending}
      />

      <RunsPanel
        runs={runs}
        runsLoading={runsLoading}
        activeSandboxId={sandboxId}
        onSelectRun={selectSandbox}
        onKillRun={(id) => killRun.mutate(id)}
        killingIds={
          killRun.isPending ? new Set([killRun.variables]) : new Set()
        }
        onKillAll={() => killAll.mutate(activeRuns.map((r) => r.id))}
        killingAll={killAll.isPending}
      />

      <PRTimeline
        lines={lines}
        agentMessages={agentMessages}
        agentBusy={agentStatus?.type === "busy"}
        viewportRef={viewportRef}
        onScroll={handleScroll}
      />
    </div>
  );
}
