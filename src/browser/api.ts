import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk";
import type { Run } from "../worker/run-types";

export type { Run };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMessage {
  info: Message;
  parts: Part[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function useRuns(owner: string, repo: string, prNumber: number) {
  return useQuery<Run[]>({
    queryKey: ["runs", owner, repo, prNumber],
    queryFn: async () => {
      const res = await fetch(
        `/runs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&pr=${prNumber}`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.runs ?? [];
    },
    refetchInterval: 500,
  });
}

// ---------------------------------------------------------------------------
// Logs (replaces SSE /stream)
// ---------------------------------------------------------------------------

export function useLogs(sandboxId: string | null) {
  return useQuery<string[]>({
    queryKey: ["logs", sandboxId],
    queryFn: async () => {
      if (!sandboxId) return [];
      const res = await fetch(`/logs?id=${encodeURIComponent(sandboxId)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.lines ?? [];
    },
    enabled: !!sandboxId,
    refetchInterval: 500,
  });
}

// ---------------------------------------------------------------------------
// Agent messages
// ---------------------------------------------------------------------------

interface MessagesResponse {
  messages: AgentMessage[];
  status: SessionStatus | null;
}

export function useMessages(sandboxId: string | null) {
  return useQuery<MessagesResponse>({
    queryKey: ["messages", sandboxId],
    queryFn: async () => {
      if (!sandboxId) return { messages: [], status: null };
      const res = await fetch(`/messages?id=${encodeURIComponent(sandboxId)}`);
      if (!res.ok) return { messages: [], status: null };
      const data = await res.json();
      return {
        messages: data.messages ?? [],
        status: data.status ?? null,
      };
    },
    enabled: !!sandboxId,
    refetchInterval: 500,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useStartRun(owner: string, repo: string, prNumber: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pr: prNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || res.statusText);
      }
      return data as { sandboxId: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["runs", owner, repo, prNumber],
      });
    },
  });
}

export function useKillRun(owner: string, repo: string, prNumber: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (runId: string) => {
      await fetch("/runs/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runs: [runId] }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["runs", owner, repo, prNumber],
      });
    },
  });
}

export function useKillAllRuns(owner: string, repo: string, prNumber: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await fetch("/runs/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["runs", owner, repo, prNumber],
      });
    },
  });
}
