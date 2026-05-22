#!/usr/bin/env node

/**
 * Forge CLI entry point.
 *
 * Uses the project's local tsx to run TypeScript directly.
 * If installed globally (npm install -g forge), tsx is a dependency.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

// Find tsx — try local node_modules first, then npx
const tsxPath = join(projectRoot, "node_modules", ".bin", "tsx");

if (existsSync(tsxPath)) {
  // Use local tsx
  const child = spawn(
    tsxPath,
    [join(__dirname, "..", "src", "index.ts"), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: process.env,
    }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  // Fallback to npx tsx
  console.error("Warning: tsx not found in node_modules. Installing...");
  const child = spawn(
    "npx",
    ["tsx", join(__dirname, "..", "src", "index.ts"), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: process.env,
    }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}