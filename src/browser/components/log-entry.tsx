import { Separator } from "@/components/ui/separator";

export function SetupLogEntry({ raw }: { raw: string }) {
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

export function SectionDivider({ label }: { label: string }) {
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
