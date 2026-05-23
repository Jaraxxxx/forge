/**
 * Provider Registry — Model-agnostic provider layer
 *
 * Supports Anthropic, OpenAI, Google, and open-source (Ollama).
 * Automatic API key detection from environment variables.
 */

import type { Provider, CompleteOptions, ProviderChunk, ModelDefinition, Message, ToolDefinition } from "../core/types.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Anthropic ────────────────────────────────────────

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
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: tm.toolCallId,
                content: Array.isArray(tm.content)
                  ? tm.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : String(tm.content ?? ""),
              },
            ],
          };
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content.map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text };
            if (block.type === "image") return { type: "image" as const, source: block.source };
            if (block.type === "toolCall") {
              return {
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.arguments,
              };
            }
            return { type: "text" as const, text: "" };
          }),
        };
      });

    const tools: Anthropic.Tool[] | undefined = opts.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const stream = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: systemMsg?.content?.[0]?.type === "text" ? systemMsg.content[0].text : opts.systemPrompt,
      messages: anthropicMsgs,
      tools: tools?.length ? tools : undefined,
      stream: true,
    }, { signal: opts.signal });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          yield {
            type: "toolCall",
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: "",
          };
        }
      } else if (event.type === "message_delta" && event.usage) {
        yield {
          type: "usage",
          usage: {
            input: event.usage.input_tokens,
            output: event.usage.output_tokens,
            cacheRead: event.usage.cache_read_input_tokens ?? 0,
            cacheWrite: event.usage.cache_creation_input_tokens ?? 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
      } else if (event.type === "message_stop") {
        yield { type: "stop", stopReason: "stop" };
      }
    }
  }

  return { name: "anthropic", complete };
}

// ─── OpenAI ───────────────────────────────────────────

import OpenAI from "openai";

export function createOpenAIProvider(apiKey?: string): Provider {
  const client = new OpenAI({ apiKey: apiKey ?? process.env.OPENAI_API_KEY });

  async function* complete(messages: Message[], opts: CompleteOptions): AsyncIterable<ProviderChunk> {
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages
      .filter((m) => m.role !== "toolResult") // tool results handled separately
      .map((m) => {
        const text = m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n");

        if (m.role === "system") return { role: "system", content: text };
        if (m.role === "assistant") return { role: "assistant", content: text };
        return { role: "user", content: text };
      });

    // Add system prompt if provided
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
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0,
      stream: true,
    }, { signal: opts.signal });

    let currentToolCall: { id: string; name: string; arguments: string } | null = null;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        yield { type: "text", text: delta.content };
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            // New tool call
            if (currentToolCall) {
              // Flush previous
              // (OpenAI sends complete tool calls in one chunk usually)
            }
            currentToolCall = {
              id: tc.id,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            };
            yield { type: "toolCall", id: tc.id, name: currentToolCall.name, arguments: currentToolCall.arguments };
          } else if (tc.function?.arguments && currentToolCall) {
            currentToolCall.arguments += tc.function.arguments;
          }
        }
      }

      // Usage (final chunk)
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

      // Finish
      if (chunk.choices?.[0]?.finish_reason) {
        yield { type: "stop", stopReason: chunk.choices[0].finish_reason };
      }
    }
  }

  return { name: "openai", complete };
}

// ─── Portkey (OpenAI-compatible proxy) ────────────────

export function createPortkeyProvider(apiKey?: string, baseUrl?: string): Provider {
  const client = new OpenAI({
    apiKey: apiKey ?? process.env.PORTKEY_API_KEY,
    baseURL: baseUrl ?? process.env.PORTKEY_BASE_URL ?? "https://api.portkey.ai/v1",
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
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0,
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

  return { name: "portkey", complete };
}

// ─── Google ───────────────────────────────────────────

export function createGoogleProvider(apiKey?: string): Provider {
  const _key = apiKey ?? process.env.GOOGLE_API_KEY;
  return {
    name: "google",
    async *complete(_messages: Message[], _opts: CompleteOptions): AsyncIterable<ProviderChunk> {
      yield { type: "text", text: "Google provider not yet implemented" };
      yield { type: "stop", stopReason: "stop" };
    },
  };
}

// ─── Ollama (local, open-source) ───────────────────────

export function createOllamaProvider(baseUrl = "http://localhost:11434"): Provider {
  return {
    name: "ollama",
    async *complete(_messages: Message[], _opts: CompleteOptions): AsyncIterable<ProviderChunk> {
      yield { type: "text", text: "Ollama provider not yet implemented" };
      yield { type: "stop", stopReason: "stop" };
    },
  };
}

// ─── Registry ─────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private models = new Map<string, ModelDefinition>();

  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  registerModel(model: ModelDefinition): void {
    this.models.set(`${model.provider}/${model.id}`, model);
  }

  get(providerName: string): Provider | undefined {
    return this.providers.get(providerName);
  }

  getModel(providerModelId: string): ModelDefinition | undefined {
    return this.models.get(providerModelId);
  }

  getAllModels(): ModelDefinition[] {
    return Array.from(this.models.values());
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Auto-detect available providers from environment and pi config */
  static autoDiscover(): ProviderRegistry {
    const registry = new ProviderRegistry();

    // ─── Portkey (priority) — reads from pi's models.json ───
    const portkeyConfig = ProviderRegistry.loadPortkeyConfig();
    if (portkeyConfig) {
      registry.register(createPortkeyProvider(portkeyConfig.apiKey, portkeyConfig.baseUrl));
      for (const model of portkeyConfig.models) {
        registry.registerModel({
          id: model.id,
          name: model.name ?? model.id,
          provider: "portkey",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 16384,
          capabilities: { coding: 0.85, speed: 0.80, costEfficiency: 0.70 },
        });
      }
    }

    // Fallback: PORTKEY_API_KEY env var
    if (!portkeyConfig && process.env.PORTKEY_API_KEY) {
      registry.register(createPortkeyProvider());
      registry.registerModel({
        id: "gpt-4o",
        name: "GPT-4o (via Portkey)",
        provider: "portkey",
        reasoning: false,
        input: ["text"],
        cost: { input: 2.50, output: 10, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      });
    }

    if (process.env.ANTHROPIC_API_KEY) {
      registry.register(createAnthropicProvider());
      registry.registerModel({
        id: "claude-sonnet-4-20250514",
        name: "Claude 4 Sonnet",
        provider: "anthropic",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 16384,
        capabilities: { coding: 0.92, security: 0.90, speed: 0.75, costEfficiency: 0.60 },
      });
      registry.registerModel({
        id: "claude-opus-4-20250514",
        name: "Claude 4 Opus",
        provider: "anthropic",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
        contextWindow: 200000,
        maxTokens: 32768,
        capabilities: { coding: 0.98, security: 0.95, speed: 0.40, costEfficiency: 0.20 },
      });
      registry.registerModel({
        id: "claude-haiku-3-5-20241022",
        name: "Claude 3.5 Haiku",
        provider: "anthropic",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
        contextWindow: 200000,
        maxTokens: 8192,
        capabilities: { coding: 0.75, security: 0.70, speed: 0.95, costEfficiency: 0.90 },
      });
    }

    if (process.env.OPENAI_API_KEY) {
      registry.register(createOpenAIProvider());
      registry.registerModel({
        id: "gpt-5",
        name: "GPT-5",
        provider: "openai",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.50, output: 10, cacheRead: 0.25, cacheWrite: 2.50 },
        contextWindow: 128000,
        maxTokens: 16384,
        capabilities: { coding: 0.90, security: 0.85, speed: 0.85, costEfficiency: 0.65 },
      });
    }

    return registry;
  }

  /** Load Portkey configuration from pi's models.json */
  private static loadPortkeyConfig(): { apiKey: string; baseUrl: string; models: Array<{ id: string; name?: string }> } | null {
    try {
      const configPath = join(homedir(), ".pi", "agent", "models.json");
      if (!existsSync(configPath)) return null;

      const raw = readFileSync(configPath, "utf-8");
      const data = JSON.parse(raw);
      const portkeyProvider = data?.providers?.portkey;
      if (!portkeyProvider) return null;

      return {
        apiKey: portkeyProvider.apiKey,
        baseUrl: portkeyProvider.baseUrl ?? "https://api.portkey.ai/v1",
        models: (portkeyProvider.models ?? []).map((m: string | { id: string; name?: string }) =>
          typeof m === "string" ? { id: m } : m
        ),
      };
    } catch {
      return null;
    }
  }
}