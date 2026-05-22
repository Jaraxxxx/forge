/**
 * Forge — CLI Entry Point
 *
 * Minimal TUI powered by terminal-kit. Reads user input,
 * streams LLM responses, renders tool calls inline.
 *
 * Usage: forge [prompt]
 *        forge           (interactive)
 */

import * as readline from "readline";
import {
  ProviderRegistry,
  createAnthropicProvider,
  createOpenAIProvider,
  createGoogleProvider,
  createOllamaProvider,
} from "./providers/registry.js";
import { agentLoop, setProvider } from "./core/agent.js";
import { DEFAULT_TOOLS } from "./tools/builtin.js";
import type { Message } from "./core/types.js";

// ─── System Prompt ────────────────────────────────────

const SYSTEM_PROMPT = `You are Forge, an AI coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools: read, write, edit, bash, grep, ls.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files
- Use edit for precise changes
- Use write for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files`;

// ─── Color helpers ────────────────────────────────────

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function dim(text: string): string {
  return DIM + text + RESET;
}

function accent(text: string): string {
  return BLUE + text + RESET;
}

// ─── CLI ──────────────────────────────────────────────

async function main(): Promise<void> {
  // Auto-discover providers from env
  const registry = ProviderRegistry.autoDiscover();

  // Default to Anthropic if available
  const provider = registry.get("anthropic") ??
    registry.get("openai") ??
    registry.get("google");

  if (!provider) {
    console.error("No API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY.");
    process.exit(1);
  }

  setProvider(provider);

  const args = process.argv.slice(2);
  const initialPrompt = args.join(" ");

  if (initialPrompt) {
    // Non-interactive: one-shot
    const history: Message[] = [];
    console.log("");
    for await (const chunk of agentLoop(initialPrompt, history, {
      provider,
      systemPrompt: SYSTEM_PROMPT,
      tools: DEFAULT_TOOLS,
    })) {
      process.stdout.write(chunk);
    }
    console.log("");
    process.exit(0);
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: Message[] = [];

  console.log("");
  console.log(accent("  ⚒  Forge — AI Coding Agent"));
  console.log(dim(`  Provider: ${provider.name}`));
  console.log(dim(`  Tools: ${DEFAULT_TOOLS.map((t) => t.name).join(", ")}`));
  console.log("");

  async function prompt(): Promise<void> {
    rl.question(accent("> "), async (input) => {
      if (!input.trim()) {
        console.log("");
        return prompt();
      }

      if (input === "/exit" || input === "/q") {
        console.log("");
        rl.close();
        process.exit(0);
      }

      console.log("");

      try {
        for await (const chunk of agentLoop(input, history, {
          provider,
          systemPrompt: SYSTEM_PROMPT,
          tools: DEFAULT_TOOLS,
        })) {
          process.stdout.write(chunk);
        }
      } catch (e: any) {
        console.log(`${YELLOW}Error: ${e.message}${RESET}`);
      }

      console.log("");
      console.log("");
      prompt();
    });
  }

  prompt();
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});