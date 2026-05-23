/**
 * Forge Server — REST + SSE API + Professional Web UI
 */

import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import {
  createOpenAIProvider,
  createAnthropicProvider,
} from "../providers/registry.js";
import { agentLoop } from "../core/agent.js";
import { DEFAULT_TOOLS } from "../tools/builtin.js";
import type { Message, SessionEntry, Session } from "./core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Session Persistence ──────────────────────────────

const FORGE_DIR = join(homedir(), ".forge");
const SESSIONS_DIR = join(FORGE_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

interface ServerSession {
  id: string;
  history: Message[];
  entries: SessionEntry[];
  leafId: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  turnCount: number;
  totalTokens: { in: number; out: number };
}

function createSession(cwd: string, model: string): ServerSession {
  const id = randomUUID();
  return { id, history: [], entries: [], leafId: id, createdAt: Date.now(), updatedAt: Date.now(), cwd, model, turnCount: 0, totalTokens: { in: 0, out: 0 } };
}

function saveSession(s: ServerSession): void {
  s.updatedAt = Date.now();
  writeFileSync(join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify(s, null, 2));
}

function loadSession(id: string): ServerSession | null {
  const p = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function listSessions(): Array<{ id: string; createdAt: number; updatedAt: number; cwd: string; turnCount: number; model: string }> {
  const sessions: any[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      sessions.push({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, cwd: s.cwd, turnCount: s.turnCount ?? 0, model: s.model ?? "" });
    } catch {}
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

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

// ─── HTML Webapp ──────────────────────────────────────

const WEBAPP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge — AI Coding Agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#09090b;--surface:#121215;--elevated:#18181b;--border:#27272a;--border-strong:#3f3f46;
  --text:#fafafa;--text-muted:#a1a1aa;--text-dim:#71717a;
  --accent:#6366f1;--accent-hover:#818cf8;--accent-muted:rgba(99,102,241,0.12);
  --green:#22c55e;--green-muted:rgba(34,197,94,0.12);
  --yellow:#eab308;--yellow-muted:rgba(234,179,8,0.12);
  --red:#ef4444;--red-muted:rgba(239,68,68,0.12);
  --orange:#f97316;--cyan:#06b6d4;--purple:#a855f7;
  --radius-sm:6px;--radius-md:8px;--radius-lg:12px;--radius-full:9999px;
  --font:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  --mono:'JetBrains Mono','SF Mono','Fira Code',monospace;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.6;display:flex}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}

/* ─── Sidebar ─── */
.sidebar{width:260px;min-width:260px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:20;transition:transform .2s ease,min-width .2s ease,width .2s ease}
.sidebar.collapsed{transform:translateX(-100%);min-width:0;width:0;overflow:hidden}
.sidebar-header{display:flex;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid var(--border)}
.sidebar-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:var(--accent);cursor:pointer;letter-spacing:-0.01em}
.sidebar-logo svg{width:22px;height:22px}
.sidebar-toggle{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;border-radius:var(--radius-sm);display:flex;align-items:center}
.sidebar-toggle:hover{color:var(--text);background:var(--elevated)}
.new-chat-btn{margin:12px;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s;font-family:var(--font)}
.new-chat-btn:hover{background:var(--accent-hover)}
.sessions-list{flex:1;overflow-y:auto;padding:8px}
.session-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--radius-sm);cursor:pointer;color:var(--text-muted);font-size:12px;transition:all .12s;margin-bottom:2px}
.session-item:hover{background:var(--elevated);color:var(--text)}
.session-item.active{background:var(--accent-muted);color:var(--accent-hover)}
.session-item .s-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-item .s-date{font-size:10px;color:var(--text-dim);font-family:var(--mono)}
.session-item .s-model{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em}

/* ─── Main ─── */
.main{flex:1;display:flex;flex-direction:column;min-width:0;position:relative}
.toolbar{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:44px;border-bottom:1px solid var(--border);background:var(--surface);gap:8px}
.toolbar-left{display:flex;align-items:center;gap:8px}
.toolbar-right{display:flex;align-items:center;gap:4px}
.btn-icon{display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:none;border-radius:var(--radius-sm);color:var(--text-muted);cursor:pointer;transition:all .12s}
.btn-icon:hover{color:var(--text);background:var(--elevated)}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:var(--radius-full);font-size:11px;font-weight:500;background:var(--elevated);color:var(--text-muted);border:1px solid var(--border)}
.pill.active{background:var(--accent-muted);color:var(--accent-hover);border-color:var(--accent)}
.pill .dot{width:6px;height:6px;border-radius:50%}
.pill .dot.green{background:var(--green)}
.pill .dot.yellow{background:var(--yellow)}
.pill .dot.accent{background:var(--accent)}
.model-select{background:var(--elevated);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:11px;font-family:var(--mono);cursor:pointer;outline:none;max-width:280px}
.model-select:focus{border-color:var(--accent)}
.model-select option{background:var(--surface);color:var(--text);font-size:12px}

/* ─── Messages ─── */
.messages{flex:1;overflow-y:auto;padding:16px 0;scroll-behavior:smooth}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim);text-align:center;gap:12px}
.empty-icon{font-size:48px;opacity:.4}
.empty-title{font-size:16px;font-weight:600;color:var(--text-muted)}
.empty-sub{font-size:13px;max-width:320px;line-height:1.5}
.message{padding:0 16px;max-width:860px;margin:0 auto;width:100%;margin-bottom:16px;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.message.user{display:flex;justify-content:flex-end}
.message.user .bubble{background:var(--elevated);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-lg);border-bottom-right-radius:var(--radius-sm);padding:10px 14px;max-width:85%;font-size:13px}
.message.assistant{display:flex;gap:10px}
.message.assistant .avatar{width:28px;height:28px;border-radius:var(--radius-sm);background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.message.assistant .bubble{flex:1;min-width:0;font-size:13px;line-height:1.7}
.message.assistant .bubble p{margin-bottom:8px}
.message.assistant .bubble pre{background:#0d0d10;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5;margin:8px 0}
.message.assistant .bubble code{font-family:var(--mono);font-size:12px;background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px}
.message.assistant .bubble pre code{background:none;padding:0}

/* ─── Tool Cards ─── */
.tool-card{border:1px solid var(--border);border-radius:var(--radius-md);margin:8px 0;overflow:hidden;background:var(--surface)}
.tool-card-header{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;user-select:none;transition:background .12s;font-size:12px}
.tool-card-header:hover{background:var(--elevated)}
.tool-card-header .tool-icon{font-size:14px}
.tool-card-header .tool-name{font-weight:600;color:var(--cyan);font-family:var(--mono);font-size:11px}
.tool-card-header .tool-args{color:var(--text-dim);font-family:var(--mono);font-size:11px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool-card-header .tool-status{font-size:10px;padding:2px 6px;border-radius:var(--radius-full)}
.tool-card-header .tool-status.running{background:var(--yellow-muted);color:var(--yellow)}
.tool-card-header .tool-status.done{background:var(--green-muted);color:var(--green)}
.tool-card-header .tool-status.error{background:var(--red-muted);color:var(--red)}
.tool-card-body{padding:10px 12px;border-top:1px solid var(--border);font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--text-muted);max-height:200px;overflow-y:auto;background:#0a0a0d;display:none}
.tool-card.expanded .tool-card-body{display:block}

.streaming-cursor{display:inline-block;width:8px;height:16px;background:var(--accent);margin-left:2px;animation:blink 1s infinite;vertical-align:text-bottom;border-radius:1px}
@keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}

/* ─── Input ─── */
.input-area{padding:12px 16px;border-top:1px solid var(--border);background:var(--surface)}
.input-wrapper{display:flex;gap:8px;align-items:flex-end;max-width:860px;margin:0 auto}
.input-box{flex:1;background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;color:var(--text);font-family:var(--font);font-size:13px;resize:none;outline:none;line-height:1.5;max-height:200px;transition:border-color .15s}
.input-box:focus{border-color:var(--accent)}
.input-box::placeholder{color:var(--text-dim)}
.send-btn{display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;transition:background .15s;flex-shrink:0}
.send-btn:hover{background:var(--accent-hover)}
.send-btn:disabled{opacity:.5;cursor:not-allowed}
.stop-btn{display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--red-muted);color:var(--red);border:1px solid var(--red);border-radius:var(--radius-sm);cursor:pointer;font-size:11px;font-weight:600;flex-shrink:0}

/* ─── Status Bar ─── */
.status-bar{display:flex;align-items:center;justify-content:space-between;height:32px;padding:0 12px;border-top:1px solid var(--border);background:var(--surface);font-size:11px;color:var(--text-muted);gap:8px;flex-shrink:0}
.status-left,.status-right{display:flex;align-items:center;gap:12px}
.status-item{display:flex;align-items:center;gap:4px;white-space:nowrap}
.status-label{color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.status-value{font-family:var(--mono);font-size:11px}
.status-value.green{color:var(--green)}
.status-value.yellow{color:var(--yellow)}
.status-value.red{color:var(--red)}
.context-bar{width:100px;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.context-bar-fill{height:100%;border-radius:2px;transition:width .3s ease,background .3s ease}
.context-bar-fill.safe{background:var(--green)}
.context-bar-fill.warn{background:var(--yellow)}
.context-bar-fill.danger{background:var(--red)}
.model-pill{cursor:pointer;position:relative}
.model-dropdown{display:none;position:absolute;bottom:100%;right:0;margin-bottom:4px;background:var(--elevated);border:1px solid var(--border-strong);border-radius:var(--radius-md);min-width:260px;max-height:320px;overflow-y:auto;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.model-dropdown.visible{display:block}
.model-dropdown .md-header{padding:8px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);position:sticky;top:0;background:var(--elevated);border-bottom:1px solid var(--border)}
.model-dropdown .md-item{padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;transition:background .1s}
.model-dropdown .md-item:hover{background:var(--accent-muted)}
.model-dropdown .md-item.active{color:var(--accent-hover);background:var(--accent-muted)}
.model-dropdown .md-item .md-name{flex:1}
.model-dropdown .md-item .md-desc{font-size:10px;color:var(--text-dim)}

/* ─── Mobile Toggle ─── */
.mobile-toggle{display:none;position:fixed;top:12px;left:12px;z-index:30;width:36px;height:36px;align-items:center;justify-content:center;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text);cursor:pointer}
@media(max-width:768px){
  .sidebar{position:fixed;top:0;left:0;bottom:0;transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .mobile-toggle{display:flex}
  .main{margin-left:0}
  .message{padding:0 12px}
  .model-select{max-width:180px}
}
</style>
</head>
<body>

<!-- Sidebar -->
<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <div class="sidebar-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
      Forge
    </div>
    <button class="sidebar-toggle" onclick="toggleSidebar()" title="Toggle sidebar">☰</button>
  </div>
  <button class="new-chat-btn" onclick="newSession()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New Session
  </button>
  <div class="sessions-list" id="sessionsList"></div>
</aside>

<!-- Mobile Toggle -->
<button class="mobile-toggle" onclick="toggleSidebar()">☰</button>

<!-- Main -->
<div class="main">
  <!-- Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <button class="btn-icon" onclick="toggleSidebar()" title="Toggle sidebar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
      </button>
      <span style="font-weight:600;font-size:13px;color:var(--text-muted)" id="sessionTitle">New Session</span>
    </div>
    <div class="toolbar-right">
      <div class="pill" id="turnsPill" title="Turn count">
        <span id="turnCount">0</span> turns
      </div>
      <div class="pill" id="statusPill" title="Session status">
        <span class="dot green"></span> idle
      </div>
    </div>
  </div>

  <!-- Messages -->
  <div class="messages" id="messages">
    <div class="empty-state">
      <div class="empty-icon">⚒</div>
      <div class="empty-title">Forge — AI Coding Agent</div>
      <div class="empty-sub">Ask me to read files, edit code, run commands, or build anything. I stream responses in real-time.</div>
    </div>
  </div>

  <!-- Input -->
  <div class="input-area">
    <div class="input-wrapper">
      <textarea class="input-box" id="input" rows="1" placeholder="Ask Forge to code..." onkeydown="handleKeydown(event)" oninput="autoResize(this)"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send message">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
      </button>
    </div>
  </div>

  <!-- Status Bar -->
  <div class="status-bar">
    <div class="status-left">
      <div class="status-item model-pill" onclick="toggleModelDropdown()" title="Change model">
        <span class="status-label">Model</span>
        <span class="status-value" id="statusModel">—</span>
        <span style="font-size:8px">▾</span>
        <div class="model-dropdown" id="modelDropdown"></div>
      </div>
      <div class="status-item">
        <span class="status-label">Tokens</span>
        <span class="status-value" id="statusTokens">0/0</span>
      </div>
      <div class="status-item" title="Context window usage">
        <span class="status-label">Context</span>
        <div class="context-bar"><div class="context-bar-fill safe" id="contextFill" style="width:0%"></div></div>
        <span class="status-value" id="statusContext" style="font-size:10px">0%</span>
      </div>
    </div>
    <div class="status-right">
      <div class="status-item">
        <span class="status-label">Cost</span>
        <span class="status-value" id="statusCost">$0.00</span>
      </div>
      <div class="status-item" id="latencyItem" style="display:none">
        <span class="status-label">Lat</span>
        <span class="status-value" id="statusLatency">—</span>
      </div>
      <div class="status-item">
        <span class="status-label">Provider</span>
        <span class="status-value" id="statusProvider">—</span>
      </div>
    </div>
  </div>
</div>

<script>
// ─── State ─────────────────────────────────────────────
const state = {
  sessionId: null,
  model: '${process.env.FORGE_MODEL || "us.anthropic.claude-sonnet-4-6/2025-01-01-preview"}',
  isStreaming: false,
  abortController: null,
  totalTokensIn: 0,
  totalTokensOut: 0,
  turnCount: 0,
  sessionStart: Date.now(),
  latency: null,
  cost: 0,
};
const PROVIDER_INFO = '${process.env.FORGE_API_KEY || process.env.PORTKEY_API_KEY ? "openai-compatible" : "anthropic"}';

// ─── Model Definitions ────────────────────────────────
const MODELS = {
  "us.anthropic.claude-sonnet-4-6/2025-01-01-preview":{name:"Claude Sonnet 4.6",desc:"Fast, capable coding",provider:"Anthropic"},
  "us.anthropic.claude-opus-4-7/2025-01-01-preview":{name:"Claude Opus 4.7",desc:"Most capable Claude",provider:"Anthropic"},
  "us.anthropic.claude-opus-4-1-20250805-v1:0/2025-01-02-preview":{name:"Claude Opus 4.1",desc:"Powerful reasoning",provider:"Anthropic"},
  "us.anthropic.claude-3-5-haiku-20241022-v1:0/2024-10-22":{name:"Claude Haiku 3.5",desc:"Fastest Claude",provider:"Anthropic"},
  "gpt-5.5/2025-04-01-preview":{name:"GPT-5.5",desc:"Latest GPT",provider:"OpenAI"},
  "gpt-5/2025-01-01-preview":{name:"GPT-5",desc:"Powerful GPT",provider:"OpenAI"},
  "gpt-4o/2025-01-01-preview":{name:"GPT-4o",desc:"Fast, capable",provider:"OpenAI"},
  "gpt-4o-mini/2025-01-01-preview":{name:"GPT-4o Mini",desc:"Fast, cheap",provider:"OpenAI"},
  "deepseek-v4-pro/2024-05-01-preview":{name:"DeepSeek V4 Pro",desc:"Strong coding",provider:"DeepSeek"},
  "gemini-3-pro-preview/2025-01-01-preview":{name:"Gemini 3 Pro",desc:"Google's best",provider:"Google"},
  "gemini-2.5-pro/2025-01-01-preview":{name:"Gemini 2.5 Pro",desc:"Strong reasoning",provider:"Google"},
  "gemini-2.5-flash/2025-01-01-preview":{name:"Gemini 2.5 Flash",desc:"Fast Gemini",provider:"Google"},
  "kimi-k2.6/2024-05-01-preview":{name:"Kimi K2.6",desc:"Moonshot AI",provider:"Moonshot"},
  "minimax.minimax-m2.5/2025-01-02-preview":{name:"Minimax M2.5",desc:"Minimax flagship",provider:"MiniMax"},
  "qwen.qwen3-next-80b-a3b/2025-01-01-preview":{name:"Qwen 3 Next 80B",desc:"Alibaba Qwen",provider:"Alibaba"},
  "llama3-3-70b-instruct-v1/2025-01-01-preview":{name:"Llama 3.3 70B",desc:"Meta's best open",provider:"Meta"},
  "gpt-4o":{name:"GPT-4o",desc:"OpenAI GPT-4o",provider:"OpenAI"},
  "claude-sonnet-4-20250514":{name:"Claude 4 Sonnet",desc:"Anthropic direct",provider:"Anthropic"},
};

// ─── DOM Helpers ──────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = (sel, el) => (el || document).querySelectorAll(sel);

function escapeHtml(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function extractText(content){return(content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\\n')}

// ─── Markdown Rendering ───────────────────────────────
function renderMarkdown(text){
  if(!text)return'';
  let html=escapeHtml(text);
  // Code blocks
  html=html.replace(/\`\`\`(\w*)\\n?([\\s\\S]*?)\`\`\`/g,(_,lang,code)=>'<pre><code>'+code.trim()+'</code></pre>');
  // Inline code
  html=html.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  // Bold
  html=html.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  // Italic
  html=html.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
  // Line breaks
  html=html.replace(/\\n/g,'<br>');
  return html;
}

// ─── Status Bar ───────────────────────────────────────
function updateStatusBar(){
  $('statusModel').textContent = (MODELS[state.model]||{}).name || state.model;
  $('statusTokens').textContent = state.totalTokensIn.toLocaleString() + ' / ' + state.totalTokensOut.toLocaleString();
  $('turnCount').textContent = state.turnCount;
  $('statusProvider').textContent = PROVIDER_INFO;
  
  const ctxPct = Math.min(100, Math.round((state.totalTokensIn / 180000) * 100));
  $('statusContext').textContent = ctxPct + '%';
  const fill = $('contextFill');
  fill.style.width = ctxPct + '%';
  fill.className = 'context-bar-fill ' + (ctxPct > 80 ? 'danger' : ctxPct > 60 ? 'warn' : 'safe');
  
  const costEst = (state.totalTokensIn * 3 / 1000000 + state.totalTokensOut * 15 / 1000000) * 1.1;
  state.cost = costEst;
  $('statusCost').textContent = '$' + costEst.toFixed(costEst < 0.01 ? 4 : 2);
  
  if(state.latency){
    $('latencyItem').style.display = '';
    $('statusLatency').textContent = (state.latency / 1000).toFixed(1) + 's';
  }
}

function setStatus(state, text){
  const el = $('statusPill');
  el.innerHTML = '<span class="dot ' + state + '"></span> ' + text;
}

function toggleModelDropdown(){
  const dd = $('modelDropdown');
  dd.classList.toggle('visible');
  if(dd.classList.contains('visible')) renderModelDropdown();
}
function renderModelDropdown(){
  const dd = $('modelDropdown');
  const grouped = {};
  for(const[id,info] of Object.entries(MODELS)){
    if(!grouped[info.provider]) grouped[info.provider] = [];
    grouped[info.provider].push({id, ...info});
  }
  let html='';
  for(const[provider,models] of Object.entries(grouped)){
    html += '<div class="md-header">'+provider+'</div>';
    for(const m of models){
      html += '<div class="md-item'+(m.id===state.model?' active':'')+'" onclick="switchModel(\''+m.id+'\')"><div class="md-name">'+m.name+'</div><div class="md-desc">'+m.desc+'</div></div>';
    }
  }
  dd.innerHTML = html;
}
function switchModel(id){
  state.model = id;
  updateStatusBar();
  $('modelDropdown').classList.remove('visible');
}
document.addEventListener('click', e => {
  if(!e.target.closest('.model-pill')) $('modelDropdown').classList.remove('visible');
});

// ─── Sidebar ──────────────────────────────────────────
function toggleSidebar(){
  const sb = $('sidebar');
  if(window.innerWidth <= 768) sb.classList.toggle('open');
  else sb.classList.toggle('collapsed');
}
async function refreshSessions(){
  try{
    const resp = await fetch('/api/sessions');
    const sessions = await resp.json();
    const list = $('sessionsList');
    list.innerHTML = sessions.map(s => {
      const d = new Date(s.updatedAt);
      const time = d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      const active = s.id === state.sessionId ? ' active' : '';
      return '<div class="session-item'+active+'" onclick="loadSessionById(\''+s.id+'\')"><div class="s-title">'+escapeHtml(s.cwd.split('/').pop()||'Session')+'</div><div class="s-model">'+(MODELS[s.model]||{}).name||''+'</div><div class="s-date">'+time+'</div></div>';
    }).join('');
  }catch(e){}
}
async function loadSessionById(id){
  try{
    const resp = await fetch('/api/sessions/'+id);
    const session = await resp.json();
    state.sessionId = session.id;
    state.turnCount = session.turnCount || 0;
    state.totalTokensIn = session.totalTokens?.in || 0;
    state.totalTokensOut = session.totalTokens?.out || 0;
    if(session.model) state.model = session.model;
    updateStatusBar();
    $('messages').innerHTML = '';
    if(session.history && session.history.length > 0){
      for(const msg of session.history){
        if(msg.role==='user') addUserMessage(msg);
        else if(msg.role==='assistant') addAssistantMessage(msg);
        else if(msg.role==='toolResult') addToolResult(msg);
      }
    } else {
      $('messages').innerHTML = '<div class="empty-state"><div class="empty-icon">⚒</div><div class="empty-title">Forge</div><div class="empty-sub">Start chatting to continue this session.</div></div>';
    }
    $('sessionTitle').textContent = session.cwd?.split('/').pop() || 'Session';
    refreshSessions();
    scrollToBottom();
  }catch(e){console.error(e)}
}
async function newSession(){
  state.sessionId = null;
  state.turnCount = 0;
  state.totalTokensIn = 0;
  state.totalTokensOut = 0;
  state.latency = null;
  state.cost = 0;
  updateStatusBar();
  $('messages').innerHTML = '<div class="empty-state"><div class="empty-icon">⚒</div><div class="empty-title">Forge — AI Coding Agent</div><div class="empty-sub">Ask me to read files, edit code, run commands, or build anything. I stream responses in real-time.</div></div>';
  $('sessionTitle').textContent = 'New Session';
  $('input').focus();
}

// ─── Messages ─────────────────────────────────────────
function scrollToBottom(){
  const m = $('messages');
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}
function addUserMessage(msg){
  const text = extractText(msg.content);
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = '<div class="bubble">'+escapeHtml(text)+'</div>';
  $('messages').appendChild(div);
  // Remove empty state
  const es = $('messages').querySelector('.empty-state');
  if(es) es.remove();
  scrollToBottom();
}
function addAssistantMessage(msg){
  const text = extractText(msg.content);
  const toolCalls = (msg.content||[]).filter(c=>c.type==='toolCall');
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = '<div class="avatar">⚒</div><div class="bubble">'+renderMarkdown(text)+'</div>';
  $('messages').appendChild(div);
  for(const tc of toolCalls) addToolCallCard(tc.id, tc.name, tc.arguments, false);
  scrollToBottom();
}
function addToolCallCard(id, name, args, collapsed){
  const div = document.createElement('div');
  div.className = 'message assistant';
  const argsStr = typeof args === 'object' ? JSON.stringify(args).slice(0,100) : String(args||'').slice(0,100);
  div.innerHTML = '<div class="avatar">🔧</div><div class="bubble"><div class="tool-card'+(collapsed?'':' expanded')+'" id="tool-'+id+'"><div class="tool-card-header" onclick="this.parentElement.classList.toggle(\'expanded\')"><span class="tool-icon">🔨</span><span class="tool-name">'+escapeHtml(name)+'</span><span class="tool-args">'+escapeHtml(argsStr)+'</span><span class="tool-status running">running</span></div><div class="tool-card-body">Running...</div></div></div>';
  $('messages').appendChild(div);
  scrollToBottom();
}
function updateToolResult(toolCallId, content, isError){
  const el = $('tool-'+toolCallId);
  if(!el) return;
  const body = el.querySelector('.tool-card-body');
  const status = el.querySelector('.tool-status');
  if(body) body.textContent = content.slice(0,5000);
  if(status){
    status.textContent = isError ? 'error' : 'done';
    status.className = 'tool-status ' + (isError ? 'error' : 'done');
  }
}
function addToolResult(msg){
  const text = extractText(msg.content);
  updateToolResult(msg.toolCallId, text, msg.isError);
}

// ─── Streaming ────────────────────────────────────────
function createStreamingAssistant(){
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'streaming-msg';
  div.innerHTML = '<div class="avatar">⚒</div><div class="bubble"><span class="streaming-cursor"></span></div>';
  $('messages').appendChild(div);
  const es = $('messages').querySelector('.empty-state');
  if(es) es.remove();
  scrollToBottom();
  return div.querySelector('.bubble');
}

async function sendMessage(){
  const input = $('input');
  const text = input.value.trim();
  if(!text || state.isStreaming) return;
  
  const es = $('messages').querySelector('.empty-state');
  if(es) es.remove();
  
  addUserMessage({role:'user',content:[{type:'text',text}]});
  input.value = ''; autoResize(input);
  
  const bubble = createStreamingAssistant();
  const cursor = bubble.querySelector('.streaming-cursor');
  
  state.isStreaming = true;
  state.abortController = new AbortController();
  const startTime = performance.now();
  $('sendBtn').style.display = 'none';
  const stopBtn = document.createElement('button');
  stopBtn.className = 'stop-btn';
  stopBtn.textContent = '■';
  stopBtn.onclick = stopStreaming;
  $('sendBtn').parentNode.appendChild(stopBtn);
  setStatus('yellow','streaming');
  
  let fullText = '';
  const toolCallIds = new Set();
  
  try{
    const resp = await fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sessionId:state.sessionId,message:text,model:state.model}),
      signal:state.abortController.signal,
    });
    if(!resp.ok) throw new Error(await resp.text());
    
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value,{stream:true});
      const lines = buffer.split('\\n');
      buffer = lines.pop()||'';
      
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        const data = line.slice(6); if(!data) continue;
        try{
          const event = JSON.parse(data);
          switch(event.type){
            case 'text':
              fullText += event.text;
              bubble.innerHTML = renderMarkdown(fullText);
              bubble.appendChild(cursor);
              break;
            case 'toolCall':
              if(!toolCallIds.has(event.id)){
                toolCallIds.add(event.id);
                addToolCallCard(event.id, event.name, event.arguments, false);
              }
              break;
            case 'toolResult':
              updateToolResult(event.toolCallId, event.content, event.isError);
              break;
            case 'usage':
              if(event.usage){
                state.totalTokensIn = (state.totalTokensIn||0)+(event.usage.input||0);
                state.totalTokensOut = (state.totalTokensOut||0)+(event.usage.output||0);
              }
              break;
            case 'done':
              state.sessionId = event.sessionId;
              state.turnCount++;
              $('sessionTitle').textContent = event.cwd?.split('/').pop()||'Session';
              refreshSessions();
              break;
            case 'error':
              bubble.innerHTML += '<div style="color:var(--red);margin-top:8px;font-size:12px">Error: '+escapeHtml(event.message)+'</div>';
              break;
          }
          updateStatusBar();
        }catch{}
      }
    }
    state.latency = performance.now() - startTime;
  }catch(e){
    if(e.name!=='AbortError'){
      bubble.innerHTML += '<div style="color:var(--red);margin-top:8px;font-size:12px">Error: '+escapeHtml(e.message)+'</div>';
    }
  }finally{
    cursor?.remove();
    state.isStreaming = false;
    state.abortController = null;
    stopBtn?.remove();
    $('sendBtn').style.display = '';
    setStatus('green','idle');
    updateStatusBar();
    scrollToBottom();
    $('input').focus();
  }
}

function stopStreaming(){
  if(state.abortController) state.abortController.abort();
}

// ─── Input ────────────────────────────────────────────
function autoResize(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}
function handleKeydown(e){
  if(e.key==='Enter'&&!e.shiftKey){
    e.preventDefault();
    sendMessage();
  }
}

// ─── Init ─────────────────────────────────────────────
updateStatusBar();
refreshSessions();
setInterval(refreshSessions, 30000);
$('input').focus();
// Restore last session if available
(async function(){
  try{
    const sessions = await (await fetch('/api/sessions')).json();
    if(sessions.length > 0 && sessions[0].id){
      loadSessionById(sessions[0].id);
    }
  }catch(e){}
})();
</script>
</body>
</html>`;

// ─── Express App ──────────────────────────────────────

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
    next();
  });

  // Static pages
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(WEBAPP_HTML);
  });
  app.get("/chat.html", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(WEBAPP_HTML);
  });

  // ─── API ───────────────────────────────────────────

  app.get("/api/sessions", (_req, res) => {
    res.json(listSessions());
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Not found" }); return; }
    res.json(session);
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    const { sessionId, message, model: requestedModel } = req.body;
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "Message is required" }); return;
    }

    let session = sessionId ? loadSession(sessionId) : undefined;
    const effectiveModel = requestedModel || process.env.FORGE_MODEL || "us.anthropic.claude-sonnet-4-6/2025-01-01-preview";
    if (!session) session = createSession(process.cwd(), effectiveModel);
    else session.model = effectiveModel;

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    const abortController = new AbortController();
    let connected = false;
    req.on("close", () => { if (connected) abortController.abort(); });
    await new Promise(r => setTimeout(r, 200));
    connected = true;

    function send(data: object): void {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // Provider
    const key = process.env.FORGE_API_KEY || process.env.PORTKEY_API_KEY || process.env.OPENAI_API_KEY;
    const baseUrl = process.env.FORGE_BASE_URL || (process.env.PORTKEY_API_KEY ? "https://api.portkey.ai/v1" : undefined) || process.env.PORTKEY_BASE_URL;
    const hasOpenAI = key;
    if (!hasOpenAI && !process.env.ANTHROPIC_API_KEY) {
      send({ type: "error", message: "No API key. Set FORGE_API_KEY, PORTKEY_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY." });
      res.end(); return;
    }
    const provider = hasOpenAI
      ? createOpenAIProvider({ apiKey: hasOpenAI as string, baseURL: baseUrl })
      : createAnthropicProvider();

    try {
      let totalInput = 0, totalOutput = 0;
      const startTime = Date.now();

      for await (const chunk of agentLoop(message, session.history, {
        provider,
        model: effectiveModel,
        systemPrompt: SYSTEM_PROMPT,
        tools: DEFAULT_TOOLS,
        signal: abortController.signal,
        onText: (text) => {
          send({ type: "text", text });
        },
        onToolCall: (toolCallId, name, args) => {
          send({ type: "toolCall", id: toolCallId, name, arguments: JSON.stringify(args).slice(0, 200) });
        },
        onToolResult: (toolCallId, content, isError) => {
          send({ type: "toolResult", toolCallId, content: content.slice(0, 5000), isError });
        },
      })) {
        // chunks handled by onText callback
      }

      // Extract usage from last assistant message
      const lastMsg = session.history[session.history.length - 1];
      if (lastMsg?.role === "assistant" && (lastMsg as any).usage) {
        const u = (lastMsg as any).usage;
        totalInput = u.input || 0;
        totalOutput = u.output || 0;
      }
      if (totalInput > 0 || totalOutput > 0) {
        send({ type: "usage", usage: { input: totalInput, output: totalOutput } });
      }

      session.turnCount = (session.turnCount || 0) + 1;
      session.totalTokens.in += totalInput;
      session.totalTokens.out += totalOutput;
      saveSession(session);
      send({ type: "done", sessionId: session.id, cwd: session.cwd });
    } catch (e: any) {
      if (e.name === "AbortError" || abortController.signal.aborted) {
        send({ type: "done", sessionId: session.id, aborted: true });
      } else {
        send({ type: "error", message: e.message || "Unknown error" });
      }
      res.end();
    }
  });

  return app;
}

export function startServer(port = 4200): void {
  const app = createApp();
  const key = process.env.FORGE_API_KEY || process.env.PORTKEY_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  app.listen(port, () => {
    console.log(`\n  \x1b[34m⚒  Forge — AI Coding Agent\x1b[0m`);
    console.log(`  \x1b[2mWebapp running at\x1b[0m \x1b[36mhttp://localhost:${port}/\x1b[0m`);
    if (!key) console.log(`  \x1b[33m⚠  No API key set — chat won't work until you set one\x1b[0m`);
    console.log("");
  });
}