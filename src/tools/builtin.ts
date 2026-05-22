/**
 * Built-in Tools — File I/O, bash, search
 *
 * Each tool is independent and stateless. Results include
 * properly typed content blocks for the LLM.
 */

import type { ToolDefinition, ToolResult, ContentBlock } from "../core/types.js";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, relative } from "path";

// ─── Read ─────────────────────────────────────────────

export const readTool: ToolDefinition = {
  name: "read",
  description: "Read contents of a file. Supports offset and limit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      offset: { type: "number", description: "Line to start reading (1-indexed)" },
      limit: { type: "number", description: "Max lines to read" },
    },
    required: ["path"],
  },
  async execute(params, _signal): Promise<ToolResult> {
    const path = resolve(params.path as string);
    if (!existsSync(path)) {
      return { content: [{ type: "text", text: `File not found: ${path}` }], isError: true };
    }
    try {
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");
      const offset = (params.offset as number) ?? 1;
      const limit = (params.limit as number) ?? 2000;
      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      return { content: [{ type: "text", text: sliced.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error reading file: ${e.message}` }], isError: true };
    }
  },
};

// ─── Write ────────────────────────────────────────────

export const writeTool: ToolDefinition = {
  name: "write",
  description: "Write/overwrite a file with content",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "File content" },
    },
    required: ["path", "content"],
  },
  async execute(params, _signal): Promise<ToolResult> {
    const path = resolve(params.path as string);
    try {
      const { mkdirSync } = await import("fs");
      const { dirname } = await import("path");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, params.content as string, "utf-8");
      return { content: [{ type: "text", text: `Wrote ${params.content?.length ?? 0} bytes to ${path}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error writing file: ${e.message}` }], isError: true };
    }
  },
};

// ─── Edit ─────────────────────────────────────────────

export const editTool: ToolDefinition = {
  name: "edit",
  description: "Edit a file using exact text replacement. Supports multiple edits.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async execute(params, _signal): Promise<ToolResult> {
    const path = resolve(params.path as string);
    const edits = (params.edits as Array<{ oldText: string; newText: string }>) ?? [];
    try {
      let content = readFileSync(path, "utf-8");
      for (const { oldText, newText } of edits) {
        if (!content.includes(oldText)) {
          return { content: [{ type: "text", text: `Edit failed: oldText not found in ${path}` }], isError: true };
        }
        content = content.replace(oldText, newText);
      }
      writeFileSync(path, content, "utf-8");
      return { content: [{ type: "text", text: `Applied ${edits.length} edit(s) to ${path}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error editing file: ${e.message}` }], isError: true };
    }
  },
};

// ─── Bash ─────────────────────────────────────────────

export const bashTool: ToolDefinition = {
  name: "bash",
  description: "Execute a shell command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command" },
      timeout: { type: "number", description: "Timeout in ms" },
    },
    required: ["command"],
  },
  async execute(params, signal): Promise<ToolResult> {
    const cmd = params.command as string;
    const timeout = (params.timeout as number) ?? 30000;
    try {
      const result = spawnSync("bash", ["-c", cmd], {
        timeout,
        maxBuffer: 50 * 1024 * 1024, // 50MB
        signal,
      });
      const stdout = result.stdout?.toString() ?? "";
      const stderr = result.stderr?.toString() ?? "";
      const output = [stdout, stderr ? `\n[stderr]\n${stderr}` : ""].filter(Boolean).join("");
      return { content: [{ type: "text", text: output || `(exit code ${result.status})` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
};

// ─── Grep ─────────────────────────────────────────────

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "Search for a pattern in files",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory or file to search" },
      include: { type: "string", description: "File pattern (e.g., '*.ts')" },
    },
    required: ["pattern"],
  },
  async execute(params, _signal): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) ?? ".";
    const include = (params.include as string) ?? "*";
    try {
      const result = spawnSync("rg", [
        "--heading",
        "--line-number",
        "--max-count=20",
        "--glob",
        include,
        pattern,
        searchPath,
      ], { timeout: 10000 });
      const output = result.stdout?.toString()?.slice(0, 2000) ?? "No matches";
      return { content: [{ type: "text", text: output }] };
    } catch {
      // Fallback: use grep
      try {
        const result = spawnSync("grep", ["-rn", "--include=" + include, pattern, searchPath], { timeout: 10000 });
        return { content: [{ type: "text", text: result.stdout?.toString()?.slice(0, 2000) ?? "No matches" }] };
      } catch {
        return { content: [{ type: "text", text: "grep/ripgrep not available" }], isError: true };
      }
    }
  },
};

// ─── LS ───────────────────────────────────────────────

export const lsTool: ToolDefinition = {
  name: "ls",
  description: "List directory contents",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  async execute(params, _signal): Promise<ToolResult> {
    const path = resolve(params.path as string);
    try {
      const entries = readdirSync(path, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  },
};

// ─── Default tool set ─────────────────────────────────

export const DEFAULT_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  lsTool,
];