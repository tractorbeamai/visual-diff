import {
  IconLoader2,
  IconCircleCheck,
  IconCircleX,
  IconBan,
  IconClock,
  IconBox,
  IconSkull,
} from "@tabler/icons-react";
import type { Run } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

export function RunsPanel({
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
              <div className="flex flex-col items-start gap-0.5">
                <Tooltip>
                  <TooltipTrigger className="font-mono font-medium text-foreground">
                    {run.commit_sha.slice(0, 7)}
                  </TooltipTrigger>
                  <TooltipContent>{run.commit_sha}</TooltipContent>
                </Tooltip>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                  <Tooltip>
                    <TooltipTrigger className="flex items-center gap-1">
                      <IconBox size={10} />
                      {run.id.slice(0, 8)}
                    </TooltipTrigger>
                    <TooltipContent>{run.id}</TooltipContent>
                  </Tooltip>
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
