import {
  IconPlayerPlay,
  IconLoader2,
  IconGitPullRequest,
  IconExternalLink,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

export function PRHeader({
  owner,
  repo,
  prNumber,
  latestCommit,
  activeRunCount,
  sandboxId,
  onStart,
  starting,
}: {
  owner: string;
  repo: string;
  prNumber: string;
  latestCommit: string | null;
  activeRunCount: number;
  sandboxId: string | null;
  onStart: () => void;
  starting: boolean;
}) {
  const ghUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  return (
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
              {activeRunCount > 0 && (
                <span className="text-amber-400">
                  {activeRunCount} active
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
          <Button onClick={onStart} disabled={starting} size="sm">
            {starting ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconPlayerPlay size={14} />
            )}
            {starting ? "Starting..." : "New run"}
          </Button>
        </div>
      </div>
    </header>
  );
}
