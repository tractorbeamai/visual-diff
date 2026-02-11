import { useState } from "react";
import type { ToolPart as SdkToolPart } from "@opencode-ai/sdk";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function ToolPartView({ part }: { part: SdkToolPart }) {
  const [open, setOpen] = useState(false);
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
    <Collapsible
      open={open}
      onOpenChange={hasDetails ? setOpen : undefined}
      className={cn(
        "border text-xs transition-colors",
        status === "error"
          ? "border-destructive/20 bg-destructive/5"
          : "border-border bg-card",
      )}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          hasDetails ? "cursor-pointer hover:bg-muted/30" : "cursor-default",
        )}
      >
        {!!hasDetails && (
          <span
            className={cn(
              "text-[10px] text-muted-foreground/40 transition-transform",
              open && "rotate-90",
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
      </CollapsibleTrigger>
      <CollapsibleContent>
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
      </CollapsibleContent>
    </Collapsible>
  );
}
