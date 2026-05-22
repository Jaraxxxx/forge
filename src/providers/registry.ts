/**
 * Provider Registry — Model-agnostic provider layer
 *
 * Supports Anthropic, OpenAI, Google, and open-source (Ollama).
 * Automatic API key detection from environment variables.
 */

import type { Provider, CompleteOptions, ProviderChunk, ModelDefinition, Message, ToolDefinition } from "../core/types.js";

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

// Placeholder — implement when needed
export function createOpenAIProvider(apiKey?: string): Provider {
  const _key = apiKey ?? process.env.OPENAI_API_KEY;
  return {
    name: "openai",
    async *complete(_messages: Message[], _opts: CompleteOptions): AsyncIterable<ProviderChunk> {
      yield { type: "text", text: "OpenAI provider not yet implemented" };
      yield { type: "stop", stopReason: "stop" };
    },
  };
}

// ─── Google ───────────────────────────────────────────

// Placeholder — implement when needed
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

  /** Auto-detect available providers from environment */
  static autoDiscover(): ProviderRegistry {
    const registry = new ProviderRegistry();

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
}