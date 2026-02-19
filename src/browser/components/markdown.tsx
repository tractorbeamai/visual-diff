import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export function TextPartView({
  text,
  isAssistant,
}: {
  text: string;
  isAssistant: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <Streamdown
      className={cn(
        "text-sm leading-relaxed",
        isAssistant ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {text}
    </Streamdown>
  );
}
