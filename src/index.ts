/**
 * Forge — Unified CLI Entry Point
 *
 * Zero config. Picks up PORTKEY_API_KEY, FORGE_API_KEY, or OPENAI_API_KEY.
 * Any OpenAI-compatible endpoint works.
 *
 * Commands:
 *   /model <id>     — switch model
 *   /models          — list available models
 *   /tools           — list active tools
 *   /status          — show session stats
 *   /system          — show/edit system prompt
 *   /clear           — clear conversation
 *   /save <name>     — save session
 *   /load <name>     — load session
 *   /export          — export as markdown
 *   /help            — help
 *   /exit, /q        — quit
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import {
  createOpenAIProvider,
  createAnthropicProvider,
} from "./providers/registry.js";
import { agentLoop, setProvider } from "./core/agent.js";
import { DEFAULT_TOOLS } from "./tools/builtin.js";
import { startServer } from "./server/index.js";
import type { Message } from "./core/types.js";

// ─── Color helpers ────────────────────────────────────

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function green(t: string) { return GREEN + t + RESET; }
function yellow(t: string) { return YELLOW + t + RESET; }
function blue(t: string) { return BLUE + t + RESET; }
function red(t: string) { return RED + t + RESET; }
function cyan(t: string) { return CYAN + t + RESET; }
function dim(t: string) { return DIM + t + RESET; }
function bold(t: string) { return BOLD + t + RESET; }

// ─── Session state ────────────────────────────────────

let currentModel: string;
let currentProvider: ReturnType<typeof createOpenAIProvider | typeof createAnthropicProvider>;
let systemPrompt = `You are Forge, an AI coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools: read, write, edit, bash, grep, ls.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files
- Use edit for precise changes
- Use write for new files or complete rewrites
- Be concise in your responses
- Show file paths clearly when working with files`;

let history: Message[] = [];
let turnCount = 0;
let totalTokens = { in: 0, out: 0 };
let sessionStart = Date.now();

// ─── Model definitions (well-known models) ────────────

const KNOWN_MODELS: Record<string, { name: string; description: string }> = {
  // Claude (via Portkey)
  "us.anthropic.claude-sonnet-4-6/2025-01-01-preview": { name: "Claude Sonnet 4.6", description: "Fast, capable coding model" },
  "us.anthropic.claude-opus-4-7/2025-01-01-preview": { name: "Claude Opus 4.7", description: "Most capable Claude" },
  "us.anthropic.claude-opus-4-1-20250805-v1:0/2025-01-02-preview": { name: "Claude Opus 4.1", description: "Powerful reasoning" },
  "us.anthropic.claude-3-5-haiku-20241022-v1:0/2024-10-22": { name: "Claude Haiku 3.5", description: "Fastest Claude" },
  // GPT
  "gpt-5.5/2025-04-01-preview": { name: "GPT-5.5", description: "Latest GPT" },
  "gpt-5/2025-01-01-preview": { name: "GPT-5", description: "Powerful GPT" },
  "gpt-4o/2025-01-01-preview": { name: "GPT-4o", description: "Fast, capable" },
  "gpt-4o-mini/2025-01-01-preview": { name: "GPT-4o Mini", description: "Fast, cheap" },
  // DeepSeek
  "deepseek-v4-pro/2024-05-01-preview": { name: "DeepSeek V4 Pro", description: "Strong coding" },
  // Gemini
  "gemini-3-pro-preview/2025-01-01-preview": { name: "Gemini 3 Pro", description: "Google's best" },
  "gemini-2.5-pro/2025-01-01-preview": { name: "Gemini 2.5 Pro", description: "Strong reasoning" },
  "gemini-2.5-flash/2025-01-01-preview": { name: "Gemini 2.5 Flash", description: "Fast Gemini" },
  // Kimi
  "kimi-k2.6/2024-05-01-preview": { name: "Kimi K2.6", description: "Moonshot AI" },
  // Minimax
  "minimax.minimax-m2.5/2025-01-02-preview": { name: "Minimax M2.5", description: "Minimax flagship" },
  // Qwen
  "qwen.qwen3-next-80b-a3b/2025-01-01-preview": { name: "Qwen 3 Next 80B", description: "Alibaba Qwen" },
  // Llama
  "llama3-3-70b-instruct-v1/2025-01-01-preview": { name: "Llama 3.3 70B", description: "Meta's best open model" },
  // OpenAI direct
  "gpt-4o": { name: "GPT-4o", description: "OpenAI GPT-4o" },
  // Anthropic direct
  "claude-sonnet-4-20250514": { name: "Claude 4 Sonnet", description: "Anthropic direct" },
  "claude-opus-4-20250514": { name: "Claude 4 Opus", description: "Anthropic direct" },
};

// ─── Config persistence ───────────────────────────────

const CONFIG_DIR = path.join(homedir(), ".forge");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function loadConfig(): Record<string, any> {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveConfig(config: Record<string, any>): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {}
}

// ─── Help ─────────────────────────────────────────────

function showHelp(): void {
  console.log("");
  console.log(bold("  ⚒  Forge Commands"));
  console.log("");
  console.log("  " + cyan("/model <id>") + "  — Switch model (e.g. /model gpt-4o)");
  console.log("  " + cyan("/models") + "      — List known models");
  console.log("  " + cyan("/tools") + "       — List active tools");
  console.log("  " + cyan("/status") + "      — Show session stats");
  console.log("  " + cyan("/system") + "      — Show system prompt");
  console.log("  " + cyan("/system edit") + " — Edit system prompt");
  console.log("  " + cyan("/clear") + "       — Clear conversation history");
  console.log("  " + cyan("/save <name>") + " — Save session");
  console.log("  " + cyan("/load <name>") + " — Load session");
  console.log("  " + cyan("/export") + "      — Export session as Markdown");
  console.log("  " + cyan("/help") + "        — This help");
  console.log("  " + cyan("/exit, /q") + "    — Quit");
  console.log("");
}

function showModels(): void {
  console.log("");
  console.log(bold("  Available Models:"));
  console.log("");
  const seen = new Set<string>();
  for (const [id, info] of Object.entries(KNOWN_MODELS)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const marker = id === currentModel ? " " + green("●") : "  ";
    console.log(`  ${marker} ${cyan(id)}`);
    console.log(`      ${dim(info.name)} — ${info.description}`);
  }
  console.log("");
  console.log(`  ${dim("Use /model <id> to switch")}`);
  console.log(`  ${dim("Or set FORGE_MODEL=... before launching")}`);
  console.log("");
}

function showStatus(): void {
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  console.log("");
  console.log(bold("  Session Status"));
  console.log("");
  console.log(`  Provider:   ${cyan(currentProvider.name)}`);
  console.log(`  Model:      ${cyan(currentModel)}`);
  console.log(`  Turns:      ${turnCount}`);
  console.log(`  History:    ${history.length} messages`);
  console.log(`  Tokens:     ${dim("in")} ${yellow(String(totalTokens.in))}  ${dim("out")} ${yellow(String(totalTokens.out))}`);
  console.log(`  Duration:   ${mins}m ${secs}s`);
  console.log(`  Tools:      ${dim(DEFAULT_TOOLS.map(t => t.name).join(", "))}`);
  console.log("");
}

function showSystem(): void {
  console.log("");
  console.log(bold("  System Prompt:"));
  console.log(dim("  ─".repeat(30)));
  for (const line of systemPrompt.split("\n")) {
    console.log(dim("  ") + line);
  }
  console.log(dim("  ─".repeat(30)));
  console.log(`  ${dim("Use /system edit to modify")}`);
  console.log("");
}

async function editSystem(rl: readline.Interface): Promise<void> {
  console.log("");
  console.log(yellow("  Enter new system prompt (empty line to finish, /cancel to abort):"));
  let lines: string[] = [];
  for (;;) {
    const input = await new Promise<string>(resolve => {
      rl.question(dim("  | "), resolve);
    });
    if (input === "/cancel") {
      console.log(dim("  Cancelled."));
      return;
    }
    if (input === "") break;
    lines.push(input);
  }
  if (lines.length > 0) {
    systemPrompt = lines.join("\n");
    console.log(green("  System prompt updated."));
  }
  console.log("");
}

function showTools(): void {
  console.log("");
  console.log(bold("  Active Tools:"));
  console.log("");
  for (const tool of DEFAULT_TOOLS) {
    console.log(`  ${cyan(tool.name)}`);
    console.log(`  ${dim("  " + tool.description)}`);
  }
  console.log("");
}

async function exportSession(): Promise<void> {
  const dir = path.join(CONFIG_DIR, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `forge-session-${ts}.md`);

  let md = `# Forge Session\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**Model:** ${currentModel}\n`;
  md += `**Turns:** ${turnCount}\n\n`;
  md += `---\n\n`;

  for (const msg of history) {
    const text = msg.content
      .filter(c => c.type === "text")
      .map(c => (c as any).text)
      .join("\n");
    if (!text.trim()) continue;

    if (msg.role === "user") {
      md += `### 👤 User\n\n${text}\n\n`;
    } else if (msg.role === "assistant") {
      md += `### 🤖 Assistant\n\n${text}\n\n`;
    }
  }

  fs.writeFileSync(file, md);
  console.log(green(`\n  Exported to: ${file}\n`));
}

function saveSession(name: string): void {
  const dir = path.join(CONFIG_DIR, "saved");
  fs.mkdirSync(dir, { recursive: true });
  const data = {
    model: currentModel,
    systemPrompt,
    history: history.map(m => ({
      role: m.role,
      content: m.content,
      usage: (m as any).usage,
      toolName: (m as any).toolName,
    })),
    turnCount,
    totalTokens,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
  console.log(green(`\n  Session saved as "${name}"\n`));
}

function loadSession(name: string): boolean {
  const file = path.join(CONFIG_DIR, "saved", `${name}.json`);
  if (!fs.existsSync(file)) {
    console.log(red(`\n  Session "${name}" not found.\n`));
    return false;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  history = data.history;
  turnCount = data.turnCount || 0;
  totalTokens = data.totalTokens || { in: 0, out: 0 };
  sessionStart = Date.now();
  if (data.model) currentModel = data.model;
  if (data.systemPrompt) systemPrompt = data.systemPrompt;
  console.log(green(`\n  Session "${name}" loaded (${history.length} messages)\n`));
  return true;
}

// ─── CLI Entry ────────────────────────────────────────

async function runCLI(initialPrompt: string): Promise<void> {
  // Set up provider
  const key = process.env.FORGE_API_KEY || process.env.PORTKEY_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.FORGE_BASE_URL
    || (process.env.PORTKEY_API_KEY ? "https://api.portkey.ai/v1" : undefined)
    || process.env.PORTKEY_BASE_URL;
  const hasOpenAI = key;
  const hasAnthropic = process.env.ANTHROPIC_API_KEY;

  if (!hasOpenAI && !hasAnthropic) {
    console.error(red("No API key found."));
    console.error("");
    console.error("Set one of:");
    console.error("  FORGE_API_KEY=sk-...       (any OpenAI-compatible key)");
    console.error("  PORTKEY_API_KEY=...        (Portkey autodetected)");
    console.error("  FORGE_BASE_URL=https://... (optional, custom endpoint)");
    console.error("  ANTHROPIC_API_KEY=sk-ant-..(Anthropic fallback)");
    console.error("");
    process.exit(1);
  }

  currentProvider = hasOpenAI
    ? createOpenAIProvider({ apiKey: hasOpenAI as string, baseURL: baseUrl })
    : createAnthropicProvider();
  setProvider(currentProvider);

  // Load saved config
  const config = loadConfig();
  currentModel = process.env.FORGE_MODEL
    || config.model
    || (hasOpenAI ? "us.anthropic.claude-sonnet-4-6/2025-01-01-preview" : "claude-sonnet-4-20250514");
  if (config.systemPrompt) systemPrompt = config.systemPrompt;

  // ─── One-shot mode ────────────────────────────────
  if (initialPrompt) {
    console.log("");
    for await (const chunk of agentLoop(initialPrompt, history, {
      provider: currentProvider,
      model: currentModel,
      systemPrompt,
      tools: DEFAULT_TOOLS,
    })) {
      process.stdout.write(chunk);
    }
    console.log("");
    process.exit(0);
  }

  // ─── Interactive mode ────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Welcome banner
  console.log("");
  console.log(blue("  ⚒  Forge — AI Coding Agent"));
  console.log(dim(`  Model:   ${currentModel}`));
  console.log(dim(`  Provider: ${hasOpenAI ? "openai-compatible" + (baseUrl ? ` (${new URL(baseUrl).hostname})` : "") : "anthropic"}`));
  console.log(dim(`  Tools:   ${DEFAULT_TOOLS.map(t => t.name).join(", ")}`));
  console.log(dim(`  Type /help for commands`));
  console.log("");

  // Command handler
  async function handleCommand(cmd: string): Promise<boolean> {
    const parts = cmd.trim().split(/\s+/);
    const action = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (action) {
      case "/model":
        if (!arg) {
          console.log(red("\n  Usage: /model <model-id>\n"));
          console.log(dim("  Use /models to see available models\n"));
        } else if (KNOWN_MODELS[arg]) {
          currentModel = arg;
          saveConfig({ ...loadConfig(), model: currentModel });
          console.log(green(`\n  Switched to ${KNOWN_MODELS[arg].name}`));
          console.log(dim(`  Model ID: ${arg}\n`));
        } else {
          console.log(yellow(`\n  Unknown model: ${arg}`));
          console.log(dim("  Use /models to see available models\n"));
        }
        return true;

      case "/models":
        showModels();
        return true;

      case "/tools":
        showTools();
        return true;

      case "/status":
        showStatus();
        return true;

      case "/system":
        if (arg === "edit") {
          await editSystem(rl);
          saveConfig({ ...loadConfig(), systemPrompt });
        } else {
          showSystem();
        }
        return true;

      case "/clear":
        history = [];
        turnCount = 0;
        totalTokens = { in: 0, out: 0 };
        sessionStart = Date.now();
        console.log(green("\n  Conversation cleared.\n"));
        return true;

      case "/save":
        if (!arg) {
          console.log(red("\n  Usage: /save <name>\n"));
        } else {
          saveSession(arg);
        }
        return true;

      case "/load":
        if (!arg) {
          console.log(red("\n  Usage: /load <name>\n"));
        } else {
          loadSession(arg);
        }
        return true;

      case "/export":
        await exportSession();
        return true;

      case "/help":
        showHelp();
        return true;

      case "/exit":
      case "/q":
        console.log(dim("\n  Goodbye.\n"));
        rl.close();
        process.exit(0);

      default:
        return false;
    }
  }

  // Main prompt loop
  function promptUser(): void {
    rl.question(blue("> "), async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        console.log("");
        return promptUser();
      }

      // Check if it's a command
      if (trimmed.startsWith("/")) {
        const handled = await handleCommand(trimmed);
        if (!handled) {
          console.log(red(`\n  Unknown command: ${trimmed}`));
          console.log(dim("  Type /help for available commands\n"));
        }
        console.log("");
        return promptUser();
      }

      console.log("");

      // Stream response
      try {
        for await (const chunk of agentLoop(trimmed, history, {
          provider: currentProvider,
          model: currentModel,
          systemPrompt,
          tools: DEFAULT_TOOLS,
          maxTurns: 25,
        })) {
          process.stdout.write(chunk);
        }
        turnCount++;
      } catch (e: any) {
        console.log(red(`\n  Error: ${e.message}\n`));
      }

      console.log("");
      console.log("");
      promptUser();
    });
  }

  promptUser();
}

// ─── Main Entry ────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "web") {
    const port = parseInt(args[1] || process.env.FORGE_PORT || "4200", 10);
    startServer(port);
    return;
  }

  const initialPrompt = args.join(" ");
  await runCLI(initialPrompt);
}

main().catch((e) => {
  console.error(red(`Fatal error: ${e.message}`));
  process.exit(1);
});