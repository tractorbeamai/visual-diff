import type React from "react";
import { cn } from "@/lib/utils";

export function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match bold, inline code, or plain text
  const pattern = /(\*\*(.+?)\*\*|`([^`]+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(
        <strong key={match.index} className="font-semibold">
          {match[2]}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(
        <code
          key={match.index}
          className="bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]"
        >
          {match[3]}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export function SimpleMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre
          key={`code-${i}`}
          className="overflow-x-auto bg-muted/50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground/80"
        >
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // Headings
    if (line.startsWith("## ")) {
      elements.push(
        <h3
          key={`h-${i}`}
          className="mt-3 mb-1 text-sm font-semibold text-foreground"
        >
          {renderInlineMarkdown(line.slice(3))}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(
        <h2
          key={`h-${i}`}
          className="mt-3 mb-1 text-base font-semibold text-foreground"
        >
          {renderInlineMarkdown(line.slice(2))}
        </h2>,
      );
      i++;
      continue;
    }

    // List items
    if (line.match(/^[-*]\s/)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        listItems.push(
          <li key={`li-${i}`}>
            {renderInlineMarkdown(lines[i].replace(/^[-*]\s/, ""))}
          </li>,
        );
        i++;
      }
      elements.push(
        <ul
          key={`ul-${i}`}
          className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed"
        >
          {listItems}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s/)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        listItems.push(
          <li key={`li-${i}`}>
            {renderInlineMarkdown(lines[i].replace(/^\d+\.\s/, ""))}
          </li>,
        );
        i++;
      }
      elements.push(
        <ol
          key={`ol-${i}`}
          className="list-decimal space-y-0.5 pl-5 text-sm leading-relaxed"
        >
          {listItems}
        </ol>,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${i}`} className="text-sm leading-relaxed">
        {renderInlineMarkdown(line)}
      </p>,
    );
    i++;
  }

  return <div className={cn("space-y-2", className)}>{elements}</div>;
}

export function TextPartView({
  text,
  isAssistant,
}: {
  text: string;
  isAssistant: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <SimpleMarkdown
      text={text}
      className={isAssistant ? "text-foreground" : "text-muted-foreground"}
    />
  );
}
