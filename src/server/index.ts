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
import type { Message } from "../core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Session Persistence ──────────────────────────────

const FORGE_DIR = join(homedir(), ".forge");
const SESSIONS_DIR = join(FORGE_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

interface ServerSession {
  id: string;
  history: Message[];
  entries: any[];
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#09090b;--surface:#121215;--elevated:#18181b;--border:#27272a;--border-strong:#3f3f46;
  --text:#fafafa;--text-muted:#a1a1aa;--text-dim:#71717a;
  --accent:#6366f1;--accent-hover:#818cf8;--accent-muted:rgba(99,102,241,0.12);
  --green:#22c55e;--green-muted:rgba(34,197,94,0.12);
  --yellow:#eab308;--yellow-muted:rgba(234,179,8,0.12);
  --red:#ef4444;--red-muted:rgba(239,68,68,0.12);
  --cyan:#06b6d4;--purple:#a855f7;--orange:#f97316;
  --radius-sm:6px;--radius-md:8px;--radius-lg:12px;--radius-full:9999px;
  --font:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  --mono:'JetBrains Mono','SF Mono','Fira Code',monospace;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.6;display:flex;flex-direction:column}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}

/* ─── Top Bar ─── */
.topbar{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;gap:12px}
.logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;color:var(--accent);letter-spacing:-0.02em;cursor:pointer}
.logo svg{width:22px;height:22px}
.model-selector{position:relative}
.model-current{display:flex;align-items:center;gap:8px;padding:6px 14px;background:var(--elevated);border:1px solid var(--border-strong);border-radius:var(--radius-md);cursor:pointer;font-size:12px;transition:all .15s;white-space:nowrap;min-width:200px;justify-content:space-between}
.model-current:hover{border-color:var(--accent);background:var(--accent-muted)}
.model-current-name{font-weight:600;color:var(--text);font-size:12px}
.model-current-provider{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em}
.model-current-arrow{font-size:10px;color:var(--text-dim);transition:transform .15s}
.model-current-arrow.open{transform:rotate(180deg)}
.model-dropdown{display:none;position:absolute;top:calc(100% + 4px);right:0;width:340px;max-height:420px;overflow-y:auto;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius-md);z-index:100;box-shadow:0 16px 40px rgba(0,0,0,.6)}
.model-dropdown.visible{display:block}
.model-dropdown .group-header{padding:8px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--border);z-index:1}
.model-dropdown .model-card{padding:10px 12px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background .1s;border-left:3px solid transparent}
.model-dropdown .model-card:hover{background:var(--elevated)}
.model-dropdown .model-card.selected{background:var(--accent-muted);border-left-color:var(--accent)}
.model-dropdown .model-card .mc-badge{width:36px;height:36px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.model-dropdown .model-card .mc-badge.anthropic{background:rgba(212,137,106,.15);color:#d4896a}
.model-dropdown .model-card .mc-badge.openai{background:rgba(116,166,139,.15);color:#74a68b}
.model-dropdown .model-card .mc-badge.deepseek{background:rgba(99,102,241,.15);color:var(--accent)}
.model-dropdown .model-card .mc-badge.google{background:rgba(66,133,244,.15);color:#4285f4}
.model-dropdown .model-card .mc-badge.moonshot{background:rgba(168,85,247,.15);color:var(--purple)}
.model-dropdown .model-card .mc-badge.minimax{background:rgba(6,182,212,.15);color:var(--cyan)}
.model-dropdown .model-card .mc-badge.alibaba{background:rgba(249,115,22,.15);color:var(--orange)}
.model-dropdown .model-card .mc-badge.meta{background:rgba(59,130,246,.15);color:#3b82f6}
.model-dropdown .model-card .mc-info{flex:1;min-width:0}
.model-dropdown .model-card .mc-name{font-weight:600;font-size:13px;color:var(--text)}
.model-dropdown .model-card .mc-desc{font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.model-dropdown .model-card .mc-check{color:var(--accent);font-size:14px;opacity:0}
.model-dropdown .model-card.selected .mc-check{opacity:1}

.topbar-right{display:flex;align-items:center;gap:12px}
.topbar-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:var(--radius-full);font-size:11px;background:var(--elevated);color:var(--text-muted);border:1px solid var(--border);font-family:var(--mono)}
.dot{width:6px;height:6px;border-radius:50%}
.dot.green{background:var(--green)}
.dot.yellow{background:var(--yellow)}
.dot.red{background:var(--red)}

/* ─── Main Layout ─── */
.layout{display:flex;flex:1;min-height:0}
.sidebar{width:260px;min-width:260px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;transition:all .2s ease;overflow:hidden}
.sidebar.collapsed{min-width:0;width:0}
.sidebar-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.sidebar-title{font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.new-session-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:8px;margin:12px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;font-family:var(--font)}
.new-session-btn:hover{background:var(--accent-hover)}
.sessions-list{flex:1;overflow-y:auto;padding:4px 8px}
.session-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--radius-sm);cursor:pointer;color:var(--text-muted);font-size:12px;transition:all .1s;margin-bottom:1px}
.session-item:hover{background:var(--elevated);color:var(--text)}
.session-item.active{background:var(--accent-muted);color:var(--accent-hover)}
.session-item .stitle{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-item .sdate{font-size:10px;color:var(--text-dim);font-family:var(--mono)}
.session-item .smodel{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.03em}

/* ─── Chat Area ─── */
.chat-area{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)}
.messages{flex:1;overflow-y:auto;padding:20px 0;scroll-behavior:smooth}

/* Welcome screen */
.welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:40px;gap:24px}
.welcome-icon{font-size:56px;opacity:.3;margin-bottom:4px}
.welcome-title{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-0.02em}
.welcome-subtitle{font-size:14px;color:var(--text-muted);max-width:400px;line-height:1.6}
.welcome-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;max-width:700px;width:100%;margin-top:12px}
.welcome-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;text-align:left;cursor:pointer;transition:all .15s}
.welcome-card:hover{border-color:var(--accent);background:var(--elevated)}
.welcome-card-icon{font-size:20px;margin-bottom:8px}
.welcome-card-title{font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px}
.welcome-card-desc{font-size:11px;color:var(--text-dim);line-height:1.5}

/* Messages */
.message{padding:0 20px;max-width:860px;margin:0 auto;width:100%;margin-bottom:16px;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.message.user{display:flex;justify-content:flex-end}
.message.user .bubble{background:var(--elevated);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-lg);border-bottom-right-radius:4px;padding:10px 14px;max-width:80%;font-size:13px;line-height:1.6}
.message.assistant{display:flex;gap:10px}
.message.assistant .avatar{width:28px;height:28px;border-radius:var(--radius-sm);background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;font-weight:700}
.message.assistant .content{flex:1;min-width:0;font-size:13px;line-height:1.7}
.message.assistant .content p{margin-bottom:8px}
.message.assistant .content pre{background:#0d0d10;border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5;margin:8px 0}
.message.assistant .content code{font-family:var(--mono);font-size:12px;background:rgba(255,255,255,0.04);padding:1px 4px;border-radius:3px}
.message.assistant .content pre code{background:none;padding:0}

/* Tool cards */
.tool-card{border:1px solid var(--border);border-radius:var(--radius-md);margin:8px 0;overflow:hidden;background:var(--surface)}
.tool-card-header{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;user-select:none;transition:background .12s;font-size:12px}
.tool-card-header:hover{background:var(--elevated)}
.tool-card-header .tool-name{font-weight:600;color:var(--cyan);font-family:var(--mono);font-size:11px}
.tool-card-header .tool-args{color:var(--text-dim);font-family:var(--mono);font-size:11px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool-card-header .tool-status{font-size:10px;padding:2px 6px;border-radius:var(--radius-full)}
.tool-card-header .tool-status.running{background:var(--yellow-muted);color:var(--yellow)}
.tool-card-header .tool-status.done{background:var(--green-muted);color:var(--green)}
.tool-card-header .tool-status.error{background:var(--red-muted);color:var(--red)}
.tool-card-body{padding:10px 12px;border-top:1px solid var(--border);font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--text-muted);max-height:200px;overflow-y:auto;background:#0a0a0d;display:none}
.tool-card.expanded .tool-card-body{display:block}

.stream-cursor{display:inline-block;width:8px;height:14px;background:var(--accent);margin-left:1px;animation:blink 1s infinite;vertical-align:middle;border-radius:1px}
@keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}

/* Input */
.input-area{padding:12px 20px 16px;border-top:1px solid var(--border);background:var(--bg);flex-shrink:0}
.input-bar{display:flex;gap:8px;align-items:flex-end;max-width:860px;margin:0 auto}
.input-box{flex:1;background:var(--elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;color:var(--text);font-family:var(--font);font-size:13px;resize:none;outline:none;line-height:1.5;max-height:200px;transition:border-color .15s}
.input-box:focus{border-color:var(--accent)}
.input-box::placeholder{color:var(--text-dim)}
.send-btn{display:flex;align-items:center;justify-content:center;width:38px;height:38px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;transition:background .15s;flex-shrink:0}
.send-btn:hover{background:var(--accent-hover)}
.send-btn:disabled{opacity:.4;cursor:not-allowed}
.stop-btn{display:flex;align-items:center;justify-content:center;width:38px;height:38px;background:var(--red-muted);color:var(--red);border:1px solid rgba(239,68,68,.3);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;font-weight:700;flex-shrink:0}

/* Status bar */
.status-bar{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 16px;background:var(--surface);border-top:1px solid var(--border);font-size:11px;color:var(--text-muted);gap:12px;flex-shrink:0}
.status-left,.status-right{display:flex;align-items:center;gap:14px}
.status-item{display:flex;align-items:center;gap:5px;white-space:nowrap}
.status-label{color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.status-value{font-family:var(--mono);font-size:11px}
.status-value.g{color:var(--green)}.status-value.y{color:var(--yellow)}.status-value.r{color:var(--red)}
.ctx-bar{width:80px;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.ctx-fill{height:100%;border-radius:2px;transition:width .3s}
.ctx-fill.s{background:var(--green)}.ctx-fill.w{background:var(--yellow)}.ctx-fill.d{background:var(--red)}

@media(max-width:768px){
  .sidebar{position:fixed;top:48px;left:0;bottom:0;z-index:20;transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .model-dropdown{position:fixed;top:52px;right:8px;left:8px;width:auto;max-height:60vh}
  .welcome-cards{grid-template-columns:1fr}
}
</style>
</head>
<body>

<!-- Top Bar -->
<div class="topbar">
  <div class="logo" onclick="newSession()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
    Forge
  </div>
  <div class="model-selector">
    <div class="model-current" id="modelCurrent" onclick="toggleModelDropdown()">
      <span class="model-current-name" id="currentModelName">Claude Sonnet 4.6</span>
      <span class="model-current-provider" id="currentModelProvider">Anthropic</span>
      <span class="model-current-arrow" id="modelArrow">▾</span>
    </div>
    <div class="model-dropdown" id="modelDropdown"></div>
  </div>
  <div class="topbar-right">
    <div class="topbar-pill" id="turnPill"><span id="turnCount">0</span> turns</div>
    <div class="topbar-pill" id="statusPill"><span class="dot green"></span> idle</div>
    <button class="send-btn" id="sidebarToggle" onclick="toggleSidebar()" title="Sessions" style="width:30px;height:30px;background:var(--elevated);color:var(--text-muted);border:1px solid var(--border)">☰</button>
  </div>
</div>

<!-- Main Layout -->
<div class="layout">

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Sessions</span>
    </div>
    <button class="new-session-btn" onclick="newSession()">+ New Session</button>
    <div class="sessions-list" id="sessionsList"></div>
  </aside>

  <!-- Chat Area -->
  <div class="chat-area">
    <div class="messages" id="messages">
      <div class="welcome" id="welcomeScreen">
        <div class="welcome-icon">⚒</div>
        <div class="welcome-title">Forge — AI Coding Agent</div>
        <div class="welcome-subtitle">Model-agnostic. Any API key. Any endpoint. Just start chatting — or choose a model above.</div>
        <div class="welcome-cards">
          <div class="welcome-card" onclick="document.getElementById('input').focus()">
            <div class="welcome-card-icon">💬</div>
            <div class="welcome-card-title">Ask anything</div>
            <div class="welcome-card-desc">Read files, edit code, run commands, build entire projects.</div>
          </div>
          <div class="welcome-card" onclick="toggleModelDropdown()">
            <div class="welcome-card-icon">🔄</div>
            <div class="welcome-card-title">Choose a model</div>
            <div class="welcome-card-desc">18 models across 7 providers. Switch anytime mid-session.</div>
          </div>
          <div class="welcome-card" onclick="document.getElementById('sidebar').classList.toggle('collapsed');refreshSessions()">
            <div class="welcome-card-icon">📂</div>
            <div class="welcome-card-title">Pick up where you left</div>
            <div class="welcome-card-desc">All sessions saved. Click sidebar to resume any conversation.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="input-area">
      <div class="input-bar">
        <textarea class="input-box" id="input" rows="1" placeholder="Ask Forge to code..." onkeydown="handleKeydown(event)" oninput="autoResize(this)"></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send (Enter)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      </div>
    </div>
  </div>

</div>

<!-- Status Bar -->
<div class="status-bar">
  <div class="status-left">
    <div class="status-item"><span class="status-label">Tokens</span><span class="status-value" id="sTokens">0 / 0</span></div>
    <div class="status-item"><span class="status-label">Context</span><div class="ctx-bar"><div class="ctx-fill s" id="sCtxFill" style="width:0%"></div></div><span class="status-value" id="sCtxPct" style="font-size:10px">0%</span></div>
  </div>
  <div class="status-right">
    <div class="status-item"><span class="status-label">Cost</span><span class="status-value" id="sCost">$0.00</span></div>
    <div class="status-item"><span class="status-label">Lat</span><span class="status-value" id="sLatency">—</span></div>
    <div class="status-item"><span class="status-label">Provider</span><span class="status-value" id="sProvider">—</span></div>
  </div>
</div>

<script>
// ─── State ─────────────────────────────────────────────
const st = {
  sid: null, model: '${process.env.FORGE_MODEL || "us.anthropic.claude-sonnet-4-6/2025-01-01-preview"}',
  streaming: false, abort: null, tIn: 0, tOut: 0, turns: 0, start: Date.now(), lat: null, cost: 0
};
const PROVIDER = '${process.env.FORGE_API_KEY || process.env.PORTKEY_API_KEY ? "openai-compatible" : "anthropic"}';

const MODELS = {
  "us.anthropic.claude-sonnet-4-6/2025-01-01-preview":{id:"us.anthropic.claude-sonnet-4-6/2025-01-01-preview",name:"Claude Sonnet 4.6",desc:"Fast, capable coding",provider:"Anthropic",icon:"🟠"},
  "us.anthropic.claude-opus-4-7/2025-01-01-preview":{id:"us.anthropic.claude-opus-4-7/2025-01-01-preview",name:"Claude Opus 4.7",desc:"Most capable Claude model",provider:"Anthropic",icon:"🟠"},
  "us.anthropic.claude-opus-4-1-20250805-v1:0/2025-01-02-preview":{id:"us.anthropic.claude-opus-4-1-20250805-v1:0/2025-01-02-preview",name:"Claude Opus 4.1",desc:"Powerful reasoning capabilities",provider:"Anthropic",icon:"🟠"},
  "us.anthropic.claude-3-5-haiku-20241022-v1:0/2024-10-22":{id:"us.anthropic.claude-3-5-haiku-20241022-v1:0/2024-10-22",name:"Claude Haiku 3.5",desc:"Fastest Claude — speed-first",provider:"Anthropic",icon:"🟠"},
  "gpt-5.5/2025-04-01-preview":{id:"gpt-5.5/2025-04-01-preview",name:"GPT-5.5",desc:"Latest and most capable GPT",provider:"OpenAI",icon:"🟢"},
  "gpt-5/2025-01-01-preview":{id:"gpt-5/2025-01-01-preview",name:"GPT-5",desc:"Powerful, balanced performance",provider:"OpenAI",icon:"🟢"},
  "gpt-4o/2025-01-01-preview":{id:"gpt-4o/2025-01-01-preview",name:"GPT-4o",desc:"Fast, capable multimodal",provider:"OpenAI",icon:"🟢"},
  "gpt-4o-mini/2025-01-01-preview":{id:"gpt-4o-mini/2025-01-01-preview",name:"GPT-4o Mini",desc:"Fast and cost-effective",provider:"OpenAI",icon:"🟢"},
  "deepseek-v4-pro/2024-05-01-preview":{id:"deepseek-v4-pro/2024-05-01-preview",name:"DeepSeek V4 Pro",desc:"Strong coding performance",provider:"DeepSeek",icon:"🔵"},
  "gemini-3-pro-preview/2025-01-01-preview":{id:"gemini-3-pro-preview/2025-01-01-preview",name:"Gemini 3 Pro",desc:"Google's most capable model",provider:"Google",icon:"🔴"},
  "gemini-2.5-pro/2025-01-01-preview":{id:"gemini-2.5-pro/2025-01-01-preview",name:"Gemini 2.5 Pro",desc:"Strong reasoning, long context",provider:"Google",icon:"🔴"},
  "gemini-2.5-flash/2025-01-01-preview":{id:"gemini-2.5-flash/2025-01-01-preview",name:"Gemini 2.5 Flash",desc:"Fast, efficient Gemini",provider:"Google",icon:"🔴"},
  "kimi-k2.6/2024-05-01-preview":{id:"kimi-k2.6/2024-05-01-preview",name:"Kimi K2.6",desc:"Moonshot AI flagship",provider:"Moonshot",icon:"🟣"},
  "minimax.minimax-m2.5/2025-01-02-preview":{id:"minimax.minimax-m2.5/2025-01-02-preview",name:"Minimax M2.5",desc:"Minimax flagship model",provider:"MiniMax",icon:"🩵"},
  "qwen.qwen3-next-80b-a3b/2025-01-01-preview":{id:"qwen.qwen3-next-80b-a3b/2025-01-01-preview",name:"Qwen 3 Next 80B",desc:"Alibaba Qwen MoE",provider:"Alibaba",icon:"🟧"},
  "llama3-3-70b-instruct-v1/2025-01-01-preview":{id:"llama3-3-70b-instruct-v1/2025-01-01-preview",name:"Llama 3.3 70B",desc:"Meta's best open model",provider:"Meta",icon:"🔷"},
  "gpt-4o":{id:"gpt-4o",name:"GPT-4o",desc:"OpenAI GPT-4o direct",provider:"OpenAI",icon:"🟢"},
  "claude-sonnet-4-20250514":{id:"claude-sonnet-4-20250514",name:"Claude 4 Sonnet",desc:"Anthropic direct API",provider:"Anthropic",icon:"🟠"},
};

// ─── Helpers ───────────────────────────────────────────
const $=id=>document.getElementById(id);
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function xt(c){return(c||[]).filter(x=>x.type==='text').map(x=>x.text).join('\\n')}
function sb(){const m=$('messages');requestAnimationFrame(()=>m.scrollTop=m.scrollHeight)}

function md(t){
  if(!t)return'';
  let h=esc(t);
  h=h.replace(/\`\`\`(\w*)\\n?([\\s\\S]*?)\`\`\`/g,(_,lang,code)=>'<pre><code>'+code.trim()+'</code></pre>');
  h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  h=h.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  h=h.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
  h=h.replace(/\\n/g,'<br>');
  return h;
}

// ─── Model Picker ─────────────────────────────────────
function updateModelDisplay(){
  const m = MODELS[st.model] || {name:st.model,provider:'?',icon:'⚙'};
  $('currentModelName').textContent = m.name;
  $('currentModelProvider').textContent = m.provider;
  $('sProvider').textContent = m.provider;
}
function toggleModelDropdown(){
  const dd = $('modelDropdown');
  const arr = $('modelArrow');
  const vis = dd.classList.toggle('visible');
  arr.classList.toggle('open', vis);
  if(vis) renderModelDropdown();
}
function renderModelDropdown(){
  const groups = {};
  for(const [id, m] of Object.entries(MODELS)){
    if(!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push(m);
  }
  const providerClass = {Anthropic:'anthropic',OpenAI:'openai',DeepSeek:'deepseek',Google:'google',Moonshot:'moonshot',MiniMax:'minimax',Alibaba:'alibaba',Meta:'meta'};
  let html = '';
  for(const [provider, models] of Object.entries(groups)){
    html += '<div class="group-header">'+provider+'</div>';
    for(const m of models){
      const sel = m.id === st.model ? ' selected' : '';
      const cc = providerClass[provider] || '';
      html += '<div class="model-card'+sel+'" data-id="'+m.id+'" onclick="pickModel(\''+m.id+'\')"><div class="mc-badge '+cc+'">'+m.icon+'</div><div class="mc-info"><div class="mc-name">'+m.name+'</div><div class="mc-desc">'+m.desc+'</div></div><div class="mc-check">✓</div></div>';
    }
  }
  $('modelDropdown').innerHTML = html;
}
function pickModel(id){
  st.model = id;
  updateModelDisplay();
  $('modelDropdown').classList.remove('visible');
  $('modelArrow').classList.remove('open');
  updateStatusBar();
}
document.addEventListener('click', e => {
  if(!e.target.closest('.model-selector')){
    $('modelDropdown').classList.remove('visible');
    $('modelArrow').classList.remove('open');
  }
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
      const d = new Date(s.updatedAt), t = d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      const mn = (MODELS[s.model]||{}).name||s.model||'';
      const active = s.id === st.sid ? ' active' : '';
      return '<div class="session-item'+active+'" onclick="loadSession(\''+s.id+'\')"><div class="stitle">'+(s.cwd?.split('/').pop()||'Session')+'</div><div class="smodel">'+mn+'</div><div class="sdate">'+t+'</div></div>';
    }).join('');
  }catch(e){}
}
async function loadSession(id){
  try{
    const resp = await fetch('/api/sessions/'+id);
    const s = await resp.json();
    st.sid = s.id; st.turns = s.turnCount||0; st.tIn = s.totalTokens?.in||0; st.tOut = s.totalTokens?.out||0;
    if(s.model) st.model = s.model;
    updateModelDisplay(); updateStatusBar();
    const el = $('messages');
    const w = $('welcomeScreen'); if(w) w.style.display='none';
    el.innerHTML = '';
    if(s.history?.length){
      for(const msg of s.history){
        if(msg.role==='user') addUserMsg(msg);
        else if(msg.role==='assistant') addAsstMsg(msg);
        else if(msg.role==='toolResult') addToolRes(msg);
      }
    }else{
      el.innerHTML = '<div class="welcome" id="welcomeScreen"><div class="welcome-icon">⚒</div><div class="welcome-title">Forge — AI Coding Agent</div><div class="welcome-subtitle">Continue this session or start a new one.</div></div>';
    }
    refreshSessions(); sb();
  }catch(e){console.error(e)}
}
async function newSession(){
  st.sid = null; st.turns = 0; st.tIn = 0; st.tOut = 0; st.lat = null; st.cost = 0;
  updateModelDisplay(); updateStatusBar();
  $('messages').innerHTML = '<div class="welcome" id="welcomeScreen"><div class="welcome-icon">⚒</div><div class="welcome-title">Forge — AI Coding Agent</div><div class="welcome-subtitle">Model-agnostic. Any API key. Any endpoint. Just start chatting — or choose a model above.</div><div class="welcome-cards"><div class="welcome-card" onclick="document.getElementById(\'input\').focus()"><div class="welcome-card-icon">💬</div><div class="welcome-card-title">Ask anything</div><div class="welcome-card-desc">Read files, edit code, run commands, build entire projects.</div></div><div class="welcome-card" onclick="toggleModelDropdown()"><div class="welcome-card-icon">🔄</div><div class="welcome-card-title">Choose a model</div><div class="welcome-card-desc">18 models across 7 providers. Switch anytime mid-session.</div></div><div class="welcome-card" onclick="document.getElementById(\'sidebar\').classList.toggle(\'collapsed\');refreshSessions()"><div class="welcome-card-icon">📂</div><div class="welcome-card-title">Pick up where you left</div><div class="welcome-card-desc">All sessions saved. Click sidebar to resume any conversation.</div></div></div></div>';
  $('input').focus();
}

// ─── Messages ─────────────────────────────────────────
function addUserMsg(msg){
  const t = xt(msg.content);
  const d = document.createElement('div'); d.className='message user';
  d.innerHTML = '<div class="bubble">'+esc(t)+'</div>';
  $('messages').appendChild(d);
  const w = $('welcomeScreen'); if(w) w.style.display='none';
  sb();
}
function addAsstMsg(msg){
  const t = xt(msg.content);
  const tcs = (msg.content||[]).filter(c=>c.type==='toolCall');
  const d = document.createElement('div'); d.className='message assistant';
  d.innerHTML = '<div class="avatar">F</div><div class="content">'+md(t)+'</div>';
  $('messages').appendChild(d);
  for(const tc of tcs) addToolCard(tc.id, tc.name, tc.arguments, false);
  sb();
}
function addToolCard(id, name, args, collapsed){
  const d = document.createElement('div'); d.className='message assistant';
  const a = typeof args==='object'?JSON.stringify(args).slice(0,120):String(args||'').slice(0,120);
  d.innerHTML = '<div class="avatar">🔧</div><div class="content"><div class="tool-card'+(collapsed?'':' expanded')+'" id="tool-'+id+'"><div class="tool-card-header" onclick="this.parentElement.classList.toggle(\'expanded\')"><span class="tool-name">'+esc(name)+'</span><span class="tool-args">'+esc(a)+'</span><span class="tool-status running">running</span></div><div class="tool-card-body">Running...</div></div></div></div>';
  $('messages').appendChild(d); sb();
}
function updToolRes(id, content, isErr){
  const el = $('tool-'+id); if(!el) return;
  const b = el.querySelector('.tool-card-body'), s = el.querySelector('.tool-status');
  if(b) b.textContent = content.slice(0,5000);
  if(s){s.textContent = isErr?'error':'done';s.className='tool-status '+(isErr?'error':'done');}
}
function addToolRes(msg){
  updToolRes(msg.toolCallId, xt(msg.content), msg.isError);
}

// ─── Streaming ────────────────────────────────────────
function startStream(){
  const d = document.createElement('div'); d.className='message assistant'; d.id='stream-msg';
  d.innerHTML = '<div class="avatar">F</div><div class="content"><span class="stream-cursor"></span></div>';
  $('messages').appendChild(d);
  const w = $('welcomeScreen'); if(w) w.style.display='none';
  sb();
  return d.querySelector('.content');
}

async function sendMessage(){
  const inp = $('input'), txt = inp.value.trim();
  if(!txt || st.streaming) return;
  const w = $('welcomeScreen'); if(w) w.style.display='none';
  addUserMsg({role:'user',content:[{type:'text',text:txt}]});
  inp.value=''; autoResize(inp);

  const bubble = startStream(), cursor = bubble.querySelector('.stream-cursor');
  st.streaming = true; st.abort = new AbortController();
  const t0 = performance.now();
  $('sendBtn').style.display = 'none';
  const stop = document.createElement('button'); stop.className='stop-btn'; stop.textContent='■'; stop.onclick=stopStream;$('sendBtn').parentNode.appendChild(stop);
  setStatus('yellow','streaming');

  let full = ''; const tcIds = new Set();
  try{
    const r = await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:st.sid,message:txt,model:st.model}),signal:st.abort.signal});
    if(!r.ok) throw new Error(await r.text());
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    while(true){
      const {done,value} = await reader.read(); if(done) break;
      buf += dec.decode(value,{stream:true}); const lines = buf.split('\\n'); buf = lines.pop()||'';
      for(const l of lines){
        if(!l.startsWith('data: ')) continue; const d = l.slice(6); if(!d) continue;
        try{
          const e = JSON.parse(d);
          switch(e.type){
            case 'text': full += e.text; bubble.innerHTML = md(full); bubble.appendChild(cursor); break;
            case 'toolCall': if(!tcIds.has(e.id)){tcIds.add(e.id);addToolCard(e.id,e.name,e.arguments,false);} break;
            case 'toolResult': updToolRes(e.toolCallId,e.content,e.isError); break;
            case 'usage': if(e.usage){st.tIn=(st.tIn||0)+(e.usage.input||0);st.tOut=(st.tOut||0)+(e.usage.output||0);} break;
            case 'done': st.sid = e.sessionId; st.turns++; refreshSessions(); break;
            case 'error': bubble.innerHTML += '<div style="color:var(--red);margin-top:8px;font-size:12px">Error: '+esc(e.message)+'</div>'; break;
          }
          updateStatusBar();
        }catch{}
      }
    }
    st.lat = performance.now() - t0;
  }catch(e){
    if(e.name!=='AbortError') bubble.innerHTML += '<div style="color:var(--red);margin-top:8px;font-size:12px">Error: '+esc(e.message)+'</div>';
  }finally{
    cursor?.remove(); st.streaming = false; st.abort = null;
    stop?.remove(); $('sendBtn').style.display='';
    setStatus('green','idle'); updateStatusBar(); sb(); $('input').focus();
  }
}
function stopStream(){if(st.abort)st.abort.abort()}

// ─── Status Bar ───────────────────────────────────────
function updateStatusBar(){
  $('sTokens').textContent = (st.tIn||0).toLocaleString()+' / '+(st.tOut||0).toLocaleString();
  $('turnCount').textContent = st.turns;
  $('sProvider').textContent = (MODELS[st.model]||{}).provider || PROVIDER;

  const ctx = Math.min(100,Math.round(((st.tIn||0)/180000)*100));
  $('sCtxPct').textContent = ctx+'%';
  const f = $('sCtxFill'); f.style.width = ctx+'%';
  f.className = 'ctx-fill '+(ctx>80?'d':ctx>60?'w':'s');

  const cost = ((st.tIn||0)*3/1e6+(st.tOut||0)*15/1e6)*1.1;
  st.cost = cost;
  $('sCost').textContent = '$'+cost.toFixed(cost<0.01?4:2);
  if(st.lat) $('sLatency').textContent = (st.lat/1000).toFixed(1)+'s';
}
function setStatus(state,text){
  $('statusPill').innerHTML = '<span class="dot '+state+'"></span> '+text;
}

// ─── Input ────────────────────────────────────────────
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,200)+'px'}
function handleKeydown(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}

// ─── Init ─────────────────────────────────────────────
updateModelDisplay(); updateStatusBar(); refreshSessions();
setInterval(refreshSessions,30000);
$('input').focus();
(async()=>{
  try{const r=await(await fetch('/api/sessions')).json();if(r.length)loadSession(r[0].id)}catch(e){}
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

      for await (const chunk of agentLoop(message, session.history, {
        provider,
        model: effectiveModel,
        systemPrompt: SYSTEM_PROMPT,
        tools: DEFAULT_TOOLS,
        signal: abortController.signal,
        onText: (text) => {
          send({ type: "text", text });
        },
        onToolCall: (toolCallId, name, _args) => {
          send({ type: "toolCall", id: toolCallId, name });
        },
        onToolResult: (toolCallId, content, isError) => {
          send({ type: "toolResult", toolCallId, content: content.slice(0, 5000), isError });
        },
      }));

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