/**
 * Provider Registry — One universal provider.
 *
 * Any OpenAI-compatible endpoint works:
 *   export FORGE_API_KEY="sk-..."
 *   export FORGE_BASE_URL="https://api.portkey.ai/v1"   # or any proxy
 *   forge --model "claude-4-sonnet/2025-01-01-preview"   # any model ID
 *
 * Falls back to Anthropic if ANTHROPIC_API_KEY is set and no OpenAI key.
 */

import type { Provider, CompleteOptions, ProviderChunk, ModelDefinition, Message, ToolDefinition } from "../core/types.js";

// ─── Universal OpenAI-compatible Provider ─────────────

import OpenAI from "openai";

export function createOpenAIProvider(opts?: { apiKey?: string; baseURL?: string }): Provider {
  const client = new OpenAI({
    apiKey: opts?.apiKey ?? process.env.FORGE_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: opts?.baseURL ?? process.env.FORGE_BASE_URL ?? "https://api.openai.com/v1",
  });

  async function* complete(messages: Message[], opts: CompleteOptions): AsyncIterable<ProviderChunk> {
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages
      .filter((m) => m.role !== "toolResult")
      .map((m) => {
        const text = m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n");
        if (m.role === "system") return { role: "system", content: text };
        if (m.role === "assistant") return { role: "assistant", content: text };
        return { role: "user", content: text };
      });

    if (opts.systemPrompt && !messages.some((m) => m.role === "system")) {
      openaiMessages.unshift({ role: "system", content: opts.systemPrompt });
    }

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = opts.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    const stream = await client.chat.completions.create({
      model: opts.model,
      messages: openaiMessages,
      tools: tools?.length ? tools : undefined,
      temperature: undefined,  // skip — some models (DeepSeek, etc.) reject temperature=0
      stream: true,
    }, { signal: opts.signal });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "text", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            yield {
              type: "toolCall",
              id: tc.id,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            };
          }
        }
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
      }

      if (chunk.choices?.[0]?.finish_reason) {
        yield { type: "stop", stopReason: chunk.choices[0].finish_reason };
      }
    }
  }

  return { name: "openai", complete };
}

// ─── Anthropic (fallback) ─────────────────────────────

import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicProvider(apiKey?: string): Provider {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });

  async function* complete(messages: Message[], opts: CompleteOptions): AsyncIterable<ProviderChunk> {
    const systemMsg = messages.find((m) => m.role === "system");
    const otherMsgs = messages.filter((m) => m.role !== "system");

    const anthropicMsgs: Anthropic.MessageParam[] = otherMsgs
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      .map((m) => {
        if (m.role === "toolResult") {
          const tm = m as any;
          return {
            role: "user" as const,
            content: [{
              type: "tool_result" as const,
              tool_use_id: tm.toolCallId,
              content: Array.isArray(tm.content)
                ? tm.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                : String(tm.content ?? ""),
            }],
          };
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content.map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text };
            if (block.type === "image") return { type: "image" as const, source: block.source };
            if (block.type === "toolCall") return {
              type: "tool_use" as const, id: block.id, name: block.name, input: block.arguments,
            };
            return { type: "text" as const, text: "" };
          }),
        };
      });

    // Convert toolResult messages to Anthropic format
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        const tm = msg as any;
        anthropicMsgs.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: tm.toolCallId,
            content: Array.isArray(tm.content)
              ? tm.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
              : String(tm.content ?? ""),
          }],
        });
      }
    }

    const stream = client.messages.stream({
      model: opts.model,
      system: systemMsg?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? opts.systemPrompt,
      messages: anthropicMsgs,
      max_tokens: opts.maxTokens ?? 4096,
      tools: opts.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as any,
      })),
    }, { signal: opts.signal });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          yield { type: "text", text: event.delta.partial_json };
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          yield { type: "toolCall", id: event.content_block.id, name: event.content_block.name, arguments: "" };
        }
      } else if (event.type === "message_stop") {
        yield { type: "stop", stopReason: "stop" };
      }
    }
  }

  return { name: "anthropic", complete };
}

// ─── Google (fallback) ────────────────────────────────

export function createGoogleProvider(apiKey?: string): Provider {
  const _key = apiKey ?? process.env.GOOGLE_API_KEY;
  return {
    name: "google",
    async *complete(_messages: Message[], _opts: CompleteOptions): AsyncIterable<ProviderChunk> {
      yield { type: "text", text: "Google provider not yet implemented. Set FORGE_API_KEY for OpenAI-compatible API." };
      yield { type: "stop", stopReason: "stop" };
    },
  };
}

// ─── Ollama (local, open-source) ───────────────────────

export function createOllamaProvider(baseUrl = "http://localhost:11434"): Provider {
  return {
    name: "ollama",
    async *complete(_messages: Message[], _opts: CompleteOptions): AsyncIterable<ProviderChunk> {
      yield { type: "text", text: "Ollama provider not yet implemented. Set FORGE_API_KEY for OpenAI-compatible API." };
      yield { type: "stop", stopReason: "stop" };
    },
  };
}

// ─── Registry ─────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  get(providerName: string): Provider | undefined {
    return this.providers.get(providerName);
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Auto-detect available providers from environment */
  static autoDiscover(): ProviderRegistry {
    const registry = new ProviderRegistry();

    // OpenAI-compatible (covers OpenAI, Portkey, Groq, Together, local proxy, etc.)
    if (process.env.FORGE_API_KEY || process.env.OPENAI_API_KEY) {
      registry.register(createOpenAIProvider());
    }

    // Anthropic (fallback)
    if (process.env.ANTHROPIC_API_KEY) {
      registry.register(createAnthropicProvider());
    }

    // Google (fallback)
    if (process.env.GOOGLE_API_KEY) {
      registry.register(createGoogleProvider());
    }

    // Ollama (local)
    registry.register(createOllamaProvider());

    return registry;
  }
}