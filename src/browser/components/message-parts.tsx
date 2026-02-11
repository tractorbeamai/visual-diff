import type {
  Part,
  TextPart as SdkTextPart,
  ToolPart as SdkToolPart,
} from "@opencode-ai/sdk";
import type { AgentMessage } from "@/api";
import { Separator } from "@/components/ui/separator";
import { TextPartView } from "@/components/markdown";
import { ToolPartView } from "@/components/tool-part";

export function MessageParts({ message }: { message: AgentMessage }) {
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
