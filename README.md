# Forge ⚒

**AI-first coding agent harness.** Model-agnostic. Context-intelligent. Self-improving.

One codebase, two interfaces — **CLI** for terminal power users, **Web** for a rich visual experience.

```bash
forge                # Interactive CLI
forge "fix the bug"  # One-shot CLI
forge web            # Start webapp → http://localhost:4200
```

## Quick Start

```bash
git clone https://github.com/Jaraxxxx/forge.git
cd forge
npm install

# CLI mode
export ANTHROPIC_API_KEY=sk-...
npx tsx src/index.ts "explain this codebase"

# Web mode
npx tsx src/index.ts web
# Open http://localhost:4200
```

## Architecture

```
                          ┌──────────────────────┐
                          │   forge              │
                          │   CLI Entry Point    │
                          │   src/index.ts       │
                          └──────────┬───────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              forge web        forge "prompt"    forge (interactive)
                    │                │                │
                    ▼                ▼                ▼
          ┌─────────────┐  ┌──────────────────────────────┐
          │ Express +   │  │      readline CLI             │
          │ SSE Server  │  │      (terminal)               │
          │ :4200       │  └──────────────┬───────────────┘
          └──────┬──────┘                 │
                 │                        │
                 └────────┬───────────────┘
                          │
                          ▼
          ┌───────────────────────────────┐
          │      agentLoop()              │
          │      src/core/agent.ts        │
          │                              │
          │  user → build context → LLM  │
          │  → parse tools → execute     │
          │  → repeat                    │
          └───────────┬───────────────────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │Anthropic│ │ OpenAI  │ │ Google  │
    │Provider │ │Provider │ │Provider │
    └─────────┘ └─────────┘ └─────────┘
          │           │           │
          └───────────┼───────────┘
                      │
          ┌───────────┴───────────┐
          │    Built-in Tools     │
          │  read write edit bash │
          │  grep ls              │
          └───────────────────────┘
```

## Features

### CLI (`forge`)
- Interactive REPL with streaming responses
- One-shot mode: `forge "prompt"`
- Multi-turn conversations
- Built-in tools: read, write, edit, bash, grep, ls

### Web App (`forge web`)
- **Streaming responses** via Server-Sent Events
- **Session persistence** — resume conversations across restarts
- **Tool call cards** — expandable, live-updating results
- **Dark theme** — GitHub-inspired design
- **Sidebar** — session list with metadata
- **Stop generation** — abort at any time
- **Zero dependencies** — vanilla HTML/JS/CSS, no React, no build step
- **Responsive** — works on desktop and tablet

## API

| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/` | Web app |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| POST | `/api/chat` | Send message (SSE stream) |

### SSE Events

| Event | Format | Description |
|-------|--------|-------------|
| `text` | `{ type: "text", text: "..." }` | Streaming text chunk |
| `toolCall` | `{ type: "toolCall", id, name, arguments }` | Tool call initiated |
| `toolResult` | `{ type: "toolResult", toolCallId, content, isError }` | Tool call result |
| `done` | `{ type: "done", sessionId, cwd }` | Turn complete |
| `error` | `{ type: "error", message }` | Error occurred |

## Project Structure

```
src/
├── core/
│   ├── types.ts        # Unified type system
│   └── agent.ts        # Streaming agent loop
├── providers/
│   └── registry.ts     # Anthropic + OpenAI + Google + Ollama
├── tools/
│   └── builtin.ts      # read, write, edit, bash, grep, ls
├── server/
│   └── index.ts        # Express + SSE server + webapp HTML
└── index.ts            # CLI entry point
```

## Design Principles

1. **Model-Agnostic** — Route to the best model per subtask
2. **Single Core** — CLI and Web use identical `agentLoop()`
3. **Lightweight** — Pure TypeScript, ~10MB deps, zero frontend framework
4. **Correct** — `content` arrays are always arrays (fixes pi's content bug)

## Roadmap

- [ ] Model router (automatic per-subtask model selection)
- [ ] Semantic context compaction (embeddings-based eviction)
- [ ] Knowledge graph (cross-session memory)
- [ ] Multi-agent reviewer council
- [ ] Extension system (pi-compatible)
- [ ] Self-improving telemetry loop

## License

MIT