# Forge ⚒

**AI-first coding agent harness.** Model-agnostic. Context-intelligent. Self-improving.

Forge combines the best of Claude Code, pi, and Codex into a single lightweight harness designed to be the state of the art for AI-powered coding.

## Quick Start

```bash
# Clone
git clone https://github.com/Jaraxxxx/forge.git
cd forge

# Install
npm install

# Run (requires ANTHROPIC_API_KEY)
npx tsx src/index.ts "explain this codebase"

# Interactive mode
npx tsx src/index.ts
```

## Architecture

```
src/
├── core/
│   ├── types.ts        # Unified type system (30+ types)
│   └── agent.ts        # Streaming agent loop with parallel tools
├── providers/
│   └── registry.ts     # Anthropic, OpenAI, Google, Ollama providers
├── tools/
│   └── builtin.ts      # read, write, edit, bash, grep, ls
└── index.ts            # CLI entry point (interactive + one-shot)
```

## Design Principles

### 1. Model-Agnostic
Route to the best model per subtask — Anthropic for security patterns, OpenAI for React, DeepSeek for SQL.

### 2. Lightweight
Pure TypeScript, ~10MB deps, no React, no Ink, no bundler. Runs with `npx tsx` directly.

### 3. Correct by Construction
- `content` arrays are ALWAYS arrays (fixes pi's `message.content is not iterable` bug)
- Streaming agent loop with proper `AbortSignal` support
- Parallel tool execution for independent tool calls

### 4. Future-Ready
- Memory layer (knowledge graph across sessions) — planned
- Semantic context compaction — planned
- Multi-agent reviewer council — planned
- Self-improving telemetry — planned
- Extension system — planned

## License

MIT