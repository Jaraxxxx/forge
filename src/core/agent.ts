/**
 * Agent Loop — The heart of Forge
 *
 * user prompt → build context → LLM call → parse tool calls → execute tools → repeat
 *
 * Features:
 * - Model-agnostic (Anthropic, OpenAI, Google, Ollama)
 * - Parallel tool execution
 * - Streaming text output
 * - Built-in tools (read, write, edit, bash, grep, ls)
 * - Event-driven extension system
 */

import type {
  Message,
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
  Usage,
  Turn,
  AgentResult,
  Provider,
  ProviderChunk,
} from "../core/types.js";
import { ProviderRegistry, createAnthropicProvider } from "../providers/registry.js";

// ─── Default Provider ─────────────────────────────────

let currentProvider: Provider;

export function setProvider(provider: Provider): void {
  currentProvider = provider;
}

export function getProvider(): Provider {
  if (!currentProvider) {
    currentProvider = createAnthropicProvider();
  }
  return currentProvider;
}

// ─── Context Building ─────────────────────────────────

export function buildMessages(
  history: Message[],
  systemPrompt?: string
): Message[] {
  const result: Message[] = [];

  if (systemPrompt) {
    result.push({
      role: "system",
      content: [{ type: "text", text: systemPrompt }],
      timestamp: Date.now(),
    });
  }

  result.push(...history);
  return result;
}

export function estimateTokens(messages: Message[]): number {
  // Rough: 1 token ≈ 4 characters for code-heavy content
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") chars += block.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

// ─── Core Agent Loop ──────────────────────────────────

export interface AgentLoopOptions {
  provider?: Provider;
  model?: string;
  systemPrompt?: string;
  tools?: import("../core/types.js").ToolDefinition[];
  maxTurns?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, content: string, isError: boolean) => void;
}

export async function* agentLoop(
  userPrompt: string,
  history: Message[],
  options: AgentLoopOptions = {}
): AsyncIterable<string> {
  const provider = options.provider ?? getProvider();
  const tools = options.tools ?? [];
  const maxTurns = options.maxTurns ?? 25;
  const signal = options.signal ?? new AbortController().signal;

  const messages = buildMessages([
    ...history,
    {
      role: "user",
      content: [{ type: "text", text: userPrompt }],
      timestamp: Date.now(),
    },
  ], options.systemPrompt);

  let turnCount = 0;

  while (turnCount < maxTurns) {
    if (signal.aborted) break;
    turnCount++;

    // Accumulate the assistant response
    const assistantBlocks: import("../core/types.js").ContentBlock[] = [];
    const toolCalls: ToolCallBlock[] = [];
    let currentToolCall: Partial<ToolCallBlock> | null = null;
    let usage: Usage | undefined;
    let stopReason = "stop";

    // Stream from the provider
    const modelId = options.model ?? "gpt-4o";
    const stream = provider.complete(messages, {
      model: modelId,
      tools: tools.length > 0 ? tools : undefined,
      systemPrompt: options.systemPrompt,
      signal,
    });

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text":
          // Yield text for TUI display
          yield chunk.text;
          if (options.onText) options.onText(chunk.text);

          // Add to last text block or create new
          const lastBlock = assistantBlocks[assistantBlocks.length - 1];
          if (lastBlock?.type === "text") {
            lastBlock.text += chunk.text;
          } else {
            assistantBlocks.push({ type: "text", text: chunk.text });
          }
          break;

        case "toolCall":
          if (!currentToolCall || currentToolCall.name !== chunk.name) {
            currentToolCall = {
              type: "toolCall",
              id: chunk.id,
              name: chunk.name,
              arguments: {},
            };
            assistantBlocks.push(currentToolCall as ToolCallBlock);
            toolCalls.push(currentToolCall as ToolCallBlock);
          }
          break;

        case "usage":
          usage = chunk.usage;
          break;

        case "stop":
          stopReason = chunk.stopReason;
          break;
      }
    }

    // Add assistant message to history
    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: assistantBlocks,
      timestamp: Date.now(),
      usage,
      stopReason,
    };
    messages.push(assistantMsg);
    history.push(assistantMsg);

    // If no tool calls, we're done
    if (toolCalls.length === 0) {
      break;
    }

    // Execute tools (parallel for independent calls)
    const toolResults: ToolResultMessage[] = [];
    const executions = toolCalls.map(async (tc) => {
      // Notify listeners
      if (options.onToolCall) {
        options.onToolCall(tc.id, tc.name, tc.arguments);
      }
      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) {
        return {
          role: "toolResult" as const,
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text" as const, text: `Error: Unknown tool "${tc.name}"` }],
          input: tc.arguments,
          isError: true,
          timestamp: Date.now(),
        };
      }

      try {
        const result = await tool.execute(tc.arguments, signal, () => {});
        return {
          role: "toolResult" as const,
          toolCallId: tc.id,
          toolName: tc.name,
          content: Array.isArray(result.content) ? result.content : [{ type: "text" as const, text: String(result.content ?? "") }],
          input: tc.arguments,
          isError: result.isError ?? false,
          result,
          timestamp: Date.now(),
        };
      } catch (e: any) {
        return {
          role: "toolResult" as const,
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          input: tc.arguments,
          isError: true,
          timestamp: Date.now(),
        };
      }
    });

    const results = await Promise.all(executions);
    for (const r of results) {
      // Notify listeners of results
      const resultText = Array.isArray(r.content)
        ? r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
        : String(r.content ?? "");
      if (options.onToolResult) {
        options.onToolResult(r.toolCallId, resultText.slice(0, 2000), r.isError ?? false);
      }

      messages.push(r as any);
      history.push(r as any);
      toolResults.push(r as unknown as ToolResultMessage);
    }
  }
}

// ─── Simplified: run once ─────────────────────────────

export async function run(
  prompt: string,
  options: AgentLoopOptions & { history?: Message[] } = {}
): Promise<string> {
  const history = options.history ?? [];
  let result = "";

  for await (const chunk of agentLoop(prompt, history, options)) {
    result += chunk;
  }

  return result;
}