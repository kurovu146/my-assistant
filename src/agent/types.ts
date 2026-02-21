// src/agent/types.ts
// ============================================================
// Agent Types — Shared interfaces cho multi-provider architecture
// ============================================================

// --- Response & Usage types (giữ nguyên contract từ claude.ts) ---

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
}

export interface AgentResponse {
  text: string;
  sessionId: string;
  toolsUsed: string[];
  usage?: UsageStats;
  error?: string;
  model?: string;
}

export interface CumulativeUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  queryCount: number;
}

export type OnProgressCallback = (update: {
  type: "thinking" | "tool_use" | "text_chunk";
  content: string;
}) => void;

// --- Query options ---

export interface AgentQueryOptions {
  prompt: string;
  sessionId?: string;
  onProgress?: OnProgressCallback;
  abortSignal?: AbortSignal;
  userId?: number;
  modelOverride?: string;
}

export interface CompletionOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
}

// --- Provider interfaces ---

/** AgentProvider — full agent mode (streaming, sessions, tools) */
export interface AgentProvider {
  readonly name: string;
  checkAuth(): Promise<{ ok: boolean; message: string }>;
  query(options: AgentQueryOptions): Promise<AgentResponse>;
  getCumulativeUsage(): CumulativeUsage;
  reloadSkills(): void;
}

/** CompletionProvider — simple text-in/text-out (cho memory, news digest) */
export interface CompletionProvider {
  complete(options: CompletionOptions): Promise<string>;
}
