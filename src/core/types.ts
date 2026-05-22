/**
 * Forge — Core Types
 *
 * The single source of truth for all types in the system.
 * Every module imports from here; nothing depends on implementation details.
 */

// ─── Messages ────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "toolResult" | "custom" | "system";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "toolResult";
  toolCallId: string;
}

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: MessageRole;
  content: ContentBlock[];
  timestamp: number;
}

export interface AssistantMessage extends Message {
  role: "assistant";
  usage?: Usage;
  stopReason?: "stop" | "toolUse" | "aborted" | "error";
  errorMessage?: string;
}

export interface ToolResultMessage extends Message {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  isError: boolean;
}

// ─── Tools ────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: object; // JSON Schema
  execute: (params: Record<string, unknown>, signal: AbortSignal, onUpdate: (partial: Partial<ToolResult>) => void) => Promise<ToolResult>;
}

export interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

// ─── Usage ────────────────────────────────────────────

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ─── Models ───────────────────────────────────────────

export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;   // per million tokens
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  capabilities?: {
    coding?: number;     // 0-1 score
    security?: number;
    speed?: number;      // relative
    costEfficiency?: number;
  };
}

// ─── Sessions ─────────────────────────────────────────

export interface SessionEntry {
  id: string;
  type: "message" | "tool" | "compaction" | "custom";
  parentId: string | null;
  message?: Message;
  timestamp: number;
  label?: string;
  data?: Record<string, unknown>;
}

export interface Session {
  id: string;
  file: string;
  entries: SessionEntry[];
  leafId: string | null;
  model?: string;
}

// ─── Agent Loop ───────────────────────────────────────

export interface Turn {
  index: number;
  messages: Message[];
  toolCalls: ToolCallBlock[];
  toolResults: ToolResultMessage[];
  usage: Usage;
}

export interface AgentResult {
  messages: Message[];
  usage: Usage;
  turns: Turn[];
}

// ─── Extension System ─────────────────────────────────

export type ExtensionEventName =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_end"
  | "message_update"
  | "tool_call"
  | "tool_result"
  | "tool_execution_start"
  | "tool_execution_end"
  | "before_agent_start"
  | "before_compact"
  | "agent_start"
  | "agent_end";

export interface ExtensionContext {
  cwd: string;
  signal?: AbortSignal;
  ui: UIMethods;
  sessionManager: SessionManager;
}

export interface UIMethods {
  notify(message: string, type: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined): void;
}

export interface SessionManager {
  getEntries(): SessionEntry[];
  getBranch(): SessionEntry[];
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getLabel(entryId: string): string | undefined;
}

export interface ExtensionAPI {
  on(event: ExtensionEventName, handler: (event: any, ctx: ExtensionContext) => any): void;
  registerTool(def: ToolDefinition): void;
  registerCommand(name: string, def: { handler: (args: string, ctx: ExtensionContext) => void }): void;
  exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

// ─── Provider ─────────────────────────────────────────

export interface Provider {
  name: string;
  complete(messages: Message[], options: CompleteOptions): AsyncIterable<ProviderChunk>;
}

export interface CompleteOptions {
  model: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: string }
  | { type: "stop"; stopReason: string }
  | { type: "usage"; usage: Usage };

// ─── Memory / Knowledge Graph ─────────────────────────

export interface KnowledgeNode {
  id: string;
  type: "fact" | "fix" | "pattern" | "decision";
  content: string;
  embedding?: number[];
  sessionId: string;
  timestamp: number;
  tags: string[];
}

export interface MemoryQuery {
  query: string;
  embedding: number[];
  topK: number;
  threshold: number;
}