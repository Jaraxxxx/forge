/**
 * Forge Server — REST + SSE API for the Forge Web App
 *
 * Serves the webapp on localhost:4200 and exposes:
 * - POST /api/chat        — start a streaming agent session
 * - GET  /api/sessions     — list all sessions
 * - GET  /api/sessions/:id  — get session details
 * - GET  /chat.html        — the webapp UI
 */

import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import {
  ProviderRegistry,
  createAnthropicProvider,
} from "../providers/registry.js";
import { agentLoop, setProvider } from "../core/agent.js";
import { DEFAULT_TOOLS } from "../tools/builtin.js";
import type { Message, SessionEntry, Session } from "./core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Session Store ────────────────────────────────────

const SESSIONS_DIR = join(homedir(), ".forge", "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

interface ServerSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  history: Message[];
  leafId: string | null;
  entries: SessionEntry[];
  cwd: string;
}

const sessionCache = new Map<string, ServerSession>();

function getSessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id: string): ServerSession | undefined {
  if (sessionCache.has(id)) return sessionCache.get(id);

  const path = getSessionPath(id);
  if (!existsSync(path)) return undefined;

  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw);
  sessionCache.set(id, data);
  return data;
}

function saveSession(session: ServerSession): void {
  sessionCache.set(session.id, session);
  writeFileSync(getSessionPath(session.id), JSON.stringify(session, null, 2));
}

function createSession(cwd: string): ServerSession {
  const id = randomUUID();
  const session: ServerSession = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
    leafId: null,
    entries: [],
    cwd,
  };
  saveSession(session);
  return session;
}

function listSessions(): Array<{ id: string; createdAt: number; updatedAt: number; cwd: string; turnCount: number }> {
  const sessions: Array<{ id: string; createdAt: number; updatedAt: number; cwd: string; turnCount: number }> = [];
  for (const entry of readdirSync(SESSIONS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.replace(".json", "");
    const s = loadSession(id);
    if (s) {
      sessions.push({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        cwd: s.cwd,
        turnCount: Math.floor(s.history.length / 2),
      });
    }
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
- Show file paths clearly when working with files
- The user is using the Forge web application`;

// ─── HTML Webapp ──────────────────────────────────────

const WEBAPP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forge — AI Coding Agent</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --dim: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
      --code-bg: #1c2128;
      --radius: 8px;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ─── Sidebar ─── */
    .sidebar {
      position: fixed;
      left: 0; top: 0; bottom: 0;
      width: 260px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      z-index: 10;
      transition: transform 0.2s ease;
    }
    .sidebar.collapsed { transform: translateX(-100%); }

    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sidebar-header h1 {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
    }
    .sidebar-header h1 span { margin-right: 6px; }

    .sessions-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .session-item {
      padding: 10px 12px;
      border-radius: var(--radius);
      cursor: pointer;
      font-size: 13px;
      color: var(--dim);
      transition: background 0.15s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .session-item:hover { background: #1c2128; color: var(--text); }
    .session-item.active { background: #1f2937; color: var(--text); }
    .session-item .icon { font-size: 16px; }
    .session-item .meta { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .session-item .title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-item .sub { font-size: 11px; color: var(--dim); }

    .new-chat-btn {
      margin: 8px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: transparent;
      color: var(--accent);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.15s;
    }
    .new-chat-btn:hover { background: #1c2128; }

    /* ─── Main Area ─── */
    .main {
      margin-left: 260px;
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      transition: margin-left 0.2s ease;
    }
    .sidebar.collapsed + .main { margin-left: 0; }

    .topbar {
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--bg);
    }
    .topbar .toggle-sidebar {
      background: none;
      border: none;
      color: var(--dim);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .topbar .toggle-sidebar:hover { color: var(--text); background: var(--surface); }
    .topbar .session-title { font-size: 14px; color: var(--dim); }
    .topbar .model-badge {
      font-size: 11px;
      padding: 2px 10px;
      border-radius: 12px;
      background: #1c2128;
      color: var(--accent);
      border: 1px solid var(--border);
    }
    .topbar .status-indicator {
      margin-left: auto;
      font-size: 11px;
      color: var(--dim);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-indicator .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--border);
    }
    .status-indicator .dot.connected { background: var(--green); }
    .status-indicator .dot.streaming { background: var(--accent); animation: pulse 1s infinite; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ─── Message Bubbles ─── */
    .message {
      max-width: 85%;
      display: flex;
      gap: 10px;
    }
    .message.user { align-self: flex-end; flex-direction: row-reverse; }
    .message.assistant { align-self: flex-start; }

    .message .avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }
    .message.user .avatar { background: #1c3a5c; }
    .message.assistant .avatar { background: #1a2e1a; }

    .message .bubble {
      padding: 12px 16px;
      border-radius: var(--radius);
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      position: relative;
    }
    .message.user .bubble {
      background: #1f2937;
      border: 1px solid #374151;
    }
    .message.assistant .bubble {
      background: var(--surface);
      border: 1px solid var(--border);
    }

    .bubble code {
      font-family: var(--mono);
      font-size: 13px;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .bubble pre {
      background: var(--code-bg);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .bubble pre code {
      background: none;
      padding: 0;
      font-size: 12px;
    }

    .streaming-cursor {
      display: inline-block;
      width: 8px;
      height: 16px;
      background: var(--accent);
      margin-left: 2px;
      animation: blink 0.8s infinite;
      vertical-align: text-bottom;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }

    /* ─── Tool Call Card ─── */
    .tool-card {
      background: #1a1e24;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin: 8px 0;
      overflow: hidden;
    }
    .tool-card .tool-header {
      padding: 8px 12px;
      background: #1c2128;
      font-size: 12px;
      color: var(--accent);
      font-family: var(--mono);
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
    }
    .tool-card .tool-header .tool-icon { font-size: 14px; }
    .tool-card .tool-header .tool-args {
      color: var(--dim);
      font-size: 11px;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool-card .tool-result {
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: var(--text);
    }
    .tool-card .tool-result.error { color: var(--red); }

    /* ─── Input Area ─── */
    .input-area {
      padding: 16px 20px;
      border-top: 1px solid var(--border);
      background: var(--bg);
    }
    .input-wrapper {
      display: flex;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px 12px;
      align-items: flex-end;
      transition: border-color 0.15s;
    }
    .input-wrapper:focus-within { border-color: var(--accent); }
    .input-wrapper textarea {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text);
      font-family: var(--font);
      font-size: 14px;
      resize: none;
      outline: none;
      padding: 4px 0;
      max-height: 200px;
      line-height: 1.5;
    }
    .input-wrapper textarea::placeholder { color: var(--dim); }
    .send-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      flex-shrink: 0;
    }
    .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .send-btn:hover:not(:disabled) { opacity: 0.85; }

    .stop-btn {
      background: var(--red);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }

    /* ─── Empty State ─── */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--dim);
    }
    .empty-state .logo { font-size: 48px; }
    .empty-state h2 { font-size: 20px; color: var(--text); }
    .empty-state p { font-size: 13px; max-width: 400px; text-align: center; line-height: 1.6; }

    @media (max-width: 768px) {
      .sidebar { width: 100%; }
      .sidebar.collapsed { transform: translateX(-100%); }
      .main { margin-left: 0; }
      .message { max-width: 95%; }
    }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <h1><span>⚒</span> Forge</h1>
      <button onclick="toggleSidebar()" style="background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;">☰</button>
    </div>
    <button class="new-chat-btn" onclick="newSession()">
      <span>+</span> New Chat
    </button>
    <div class="sessions-list" id="sessionsList">
      <div style="padding:16px;color:var(--dim);font-size:12px;text-align:center;">Loading sessions...</div>
    </div>
  </aside>

  <!-- Main -->
  <div class="main" id="main">
    <div class="topbar">
      <button class="toggle-sidebar" onclick="toggleSidebar()">☰</button>
      <span class="session-title" id="sessionTitle">New Session</span>
      <span class="model-badge" id="modelBadge">Claude 4 Sonnet</span>
      <div class="status-indicator">
        <span class="dot" id="statusDot"></span>
        <span id="statusText">Offline</span>
      </div>
    </div>

    <div class="messages" id="messages">
      <div class="empty-state">
        <div class="logo">⚒</div>
        <h2>Welcome to Forge</h2>
        <p>AI-first coding agent. Read files, edit code, run commands — all from your browser.</p>
        <p style="color:var(--dim);font-size:12px;">Type a message below to start.</p>
      </div>
    </div>

    <div class="input-area">
      <div class="input-wrapper">
        <textarea
          id="input"
          rows="1"
          placeholder="Ask anything — read files, edit code, run commands..."
          onkeydown="handleKeydown(event)"
          oninput="autoResize(this)"
        ></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()">Send</button>
      </div>
    </div>
  </div>

  <script>
    // ─── State ───────────────────────────────────────
    const state = {
      sessionId: null,
      isStreaming: false,
      abortController: null,
    };

    const $ = (id) => document.getElementById(id);
    const msgContainer = $('messages');
    const input = $('input');
    const sendBtn = $('sendBtn');
    const sidebar = $('sidebar');

    // ─── Sidebar ─────────────────────────────────────
    function toggleSidebar() {
      sidebar.classList.toggle('collapsed');
    }

    // ─── Session Management ──────────────────────────
    async function newSession() {
      state.sessionId = null;
      state.isStreaming = false;
      msgContainer.innerHTML = \`
        <div class="empty-state">
          <div class="logo">⚒</div>
          <h2>New Session</h2>
          <p>AI-first coding agent. What would you like to do?</p>
        </div>\`;
      $('sessionTitle').textContent = 'New Session';
      loadSessions();
    }

    async function loadSessions() {
      try {
        const resp = await fetch('/api/sessions');
        const sessions = await resp.json();
        renderSessions(sessions);
      } catch {
        $('sessionsList').innerHTML =
          '<div style="padding:16px;color:var(--red);font-size:12px;">Failed to load</div>';
      }
    }

    function renderSessions(sessions) {
      if (!sessions.length) {
        $('sessionsList').innerHTML =
          '<div style="padding:16px;color:var(--dim);font-size:12px;text-align:center;">No sessions yet</div>';
        return;
      }
      $('sessionsList').innerHTML = sessions.map(s => {
        const dt = new Date(s.updatedAt);
        const time = dt.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        const active = s.id === state.sessionId ? ' active' : '';
        return \`
          <div class="session-item\${active}" onclick="switchSession('\${s.id}')">
            <span class="icon">💬</span>
            <div class="meta">
              <span class="title">\${s.cwd.split('/').pop() || s.cwd}</span>
              <span class="sub">\${s.turnCount} turns · \${time}</span>
            </div>
          </div>\`;
      }).join('');
    }

    async function switchSession(id) {
      state.sessionId = id;
      state.isStreaming = false;
      try {
        const resp = await fetch('/api/sessions/' + id);
        const session = await resp.json();
        renderHistory(session.history || []);
        $('sessionTitle').textContent = session.cwd.split('/').pop() || 'Session';
        loadSessions();
      } catch {
        newSession();
      }
    }

    function renderHistory(history) {
      msgContainer.innerHTML = '';
      if (!history.length) {
        msgContainer.innerHTML = \`
          <div class="empty-state">
            <div class="logo">⚒</div>
            <h2>Session loaded</h2>
            <p>Start chatting to continue this session.</p>
          </div>\`;
        return;
      }
      for (const msg of history) {
        if (msg.role === 'user') addUserMessage(msg);
        else if (msg.role === 'assistant') addAssistantMessage(msg);
        else if (msg.role === 'toolResult') addToolResult(msg);
      }
      scrollToBottom();
    }

    // ─── Message Rendering ───────────────────────────
    function addUserMessage(msg) {
      const text = extractText(msg.content);
      const div = document.createElement('div');
      div.className = 'message user';
      div.innerHTML = \`
        <div class="avatar">👤</div>
        <div class="bubble">\${escapeHtml(text)}</div>\`;
      msgContainer.appendChild(div);
      scrollToBottom();
    }

    function addAssistantMessage(msg) {
      const text = extractText(msg.content);
      const toolCalls = (msg.content || []).filter(c => c.type === 'toolCall');
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.innerHTML = \`
        <div class="avatar">⚒</div>
        <div class="bubble">\${renderMarkdown(text)}</div>\`;
      msgContainer.appendChild(div);

      // Render tool calls
      for (const tc of toolCalls) {
        addToolCall(tc);
      }
      scrollToBottom();
    }

    function addToolCall(tc) {
      const div = document.createElement('div');
      div.className = 'message assistant';
      const argsPreview = JSON.stringify(tc.arguments || {}).slice(0, 80);
      div.innerHTML = \`
        <div class="avatar">🔧</div>
        <div class="bubble" style="width:100%;">
          <div class="tool-card">
            <div class="tool-header">
              <span class="tool-icon">🔨</span>
              <span>\${tc.name}</span>
              <span class="tool-args">\${escapeHtml(argsPreview)}</span>
            </div>
            <div class="tool-result" id="tool-\${tc.id}">
              <span style="color:var(--dim);">Running...</span>
            </div>
          </div>
        </div>\`;
      msgContainer.appendChild(div);
      scrollToBottom();
      return div;
    }

    function updateToolResult(toolCallId, content, isError) {
      const el = document.getElementById('tool-' + toolCallId);
      if (el) {
        el.textContent = content;
        if (isError) el.classList.add('error');
      }
    }

    function addToolResult(msg) {
      const toolCallId = msg.toolCallId;
      const text = extractText(msg.content);
      updateToolResult(toolCallId, text, msg.isError);
    }

    // ─── Streaming ───────────────────────────────────
    function createStreamingAssistant() {
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.id = 'streaming-msg';
      div.innerHTML = \`
        <div class="avatar">⚒</div>
        <div class="bubble"><span class="streaming-cursor"></span></div>\`;
      msgContainer.appendChild(div);
      scrollToBottom();
      return div.querySelector('.bubble');
    }

    async function sendMessage() {
      const text = input.value.trim();
      if (!text || state.isStreaming) return;

      // Clear empty state
      const empty = msgContainer.querySelector('.empty-state');
      if (empty) empty.remove();

      // Add user message
      const userMsg = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
      addUserMessage(userMsg);
      input.value = '';
      autoResize(input);

      // Create streaming bubble
      const bubble = createStreamingAssistant();
      const cursor = bubble.querySelector('.streaming-cursor');

      // Update UI
      state.isStreaming = true;
      state.abortController = new AbortController();
      sendBtn.style.display = 'none';
      const stopBtn = document.createElement('button');
      stopBtn.className = 'stop-btn';
      stopBtn.textContent = 'Stop';
      stopBtn.onclick = stopStreaming;
      sendBtn.parentNode.appendChild(stopBtn);

      setStatus('streaming', 'Streaming');

      let fullText = '';
      const toolCalls = [];

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: state.sessionId,
            message: text,
          }),
          signal: state.abortController.signal,
        });

        if (!resp.ok) throw new Error(await resp.text());

        // Read SSE stream
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (!data) continue;

            try {
              const event = JSON.parse(data);

              switch (event.type) {
                case 'text':
                  fullText += event.text;
                  bubble.innerHTML = renderMarkdown(fullText);
                  bubble.appendChild(cursor);
                  break;

                case 'toolCall':
                  toolCalls.push(event);
                  const tcDiv = addToolCall(event);
                  break;

                case 'toolResult':
                  updateToolResult(event.toolCallId, event.content, event.isError);
                  break;

                case 'done':
                  state.sessionId = event.sessionId;
                  $('sessionTitle').textContent = event.cwd?.split('/').pop() || 'Session';
                  break;

                case 'error':
                  bubble.innerHTML += \`
                    <div style="color:var(--red);margin-top:8px;font-size:13px;">
                      Error: \${escapeHtml(event.message)}
                    </div>\`;
                  break;
              }
            } catch {}
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          bubble.innerHTML += \`
            <div style="color:var(--red);margin-top:8px;font-size:13px;">
              Error: \${escapeHtml(e.message)}
            </div>\`;
        }
      } finally {
        // Clean up
        cursor?.remove();
        state.isStreaming = false;
        state.abortController = null;
        const stopBtnEl = sendBtn.parentNode.querySelector('.stop-btn');
        if (stopBtnEl) stopBtnEl.remove();
        sendBtn.style.display = '';
        setStatus('connected', 'Connected');
        if (state.sessionId) loadSessions();
        scrollToBottom();
        input.focus();
      }
    }

    function stopStreaming() {
      if (state.abortController) {
        state.abortController.abort();
      }
    }

    // ─── Helpers ─────────────────────────────────────
    function extractText(content) {
      if (!Array.isArray(content)) return '';
      return content.filter(c => c.type === 'text').map(c => c.text).join('\\n');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function renderMarkdown(text) {
      // Simple markdown: code blocks and inline code
      let html = escapeHtml(text)
        .replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      return html;
    }

    function setStatus(cls, text) {
      $('statusDot').className = 'dot ' + cls;
      $('statusText').textContent = text;
    }

    function handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    function autoResize(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }

    function scrollToBottom() {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // ─── Init ────────────────────────────────────────
    loadSessions();
    input.focus();
    setStatus('connected', 'Connected');
  </script>
</body>
</html>`;

// ─── Express App ──────────────────────────────────────

export function createApp(providerName?: string): express.Express {
  const app = express();
  app.use(express.json());

  // Enable CORS for any origin (local dev)
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (_req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // ─── Serve Webapp ──────────────────────────────────
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(WEBAPP_HTML);
  });

  app.get("/chat.html", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(WEBAPP_HTML);
  });

  // ─── API Routes ────────────────────────────────────

  // List sessions
  app.get("/api/sessions", (_req, res) => {
    res.json(listSessions());
  });

  // Get session
  app.get("/api/sessions/:id", (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  });

  // Chat with streaming (SSE)
  app.post("/api/chat", async (req: Request, res: Response) => {
    const { sessionId, message } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    // Get or create session
    let session = sessionId ? loadSession(sessionId) : undefined;
    if (!session) {
      session = createSession(process.cwd());
    }

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const abortController = new AbortController();

    // Handle client disconnect
    req.on("close", () => {
      abortController.abort();
    });

    function send(data: object): void {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // Auto-discover provider — Portkey first
    const registry = ProviderRegistry.autoDiscover();
    const provider = registry.get("portkey") ?? registry.get("anthropic");

    if (!provider) {
      send({ type: "error", message: "No provider configured. Set PORTKEY_API_KEY or ANTHROPIC_API_KEY." });
      res.end();
      return;
    }

    try {
      // Add user message to history
      const userMsg: Message = {
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
      };
      session.history.push(userMsg);
      session.entries.push({
        id: randomUUID(),
        type: "message",
        parentId: session.leafId,
        message: userMsg,
        timestamp: Date.now(),
      });
      session.leafId = session.entries[session.entries.length - 1].id;

      // Track tool calls for results
      const pendingToolCalls = new Map<string, string>();

      // Snapshot of history length before this turn
      const historyLenBefore = session.history.length;

      // Run agent loop — tool calls/results forwarded via callbacks
      for await (const chunk of agentLoop(message, session.history, {
        provider,
        systemPrompt: SYSTEM_PROMPT,
        tools: DEFAULT_TOOLS,
        signal: abortController.signal,
        onText: (text) => {
          send({ type: "text", text });
        },
        onToolCall: (toolCallId, name, args) => {
          send({
            type: "toolCall",
            id: toolCallId,
            name,
            arguments: JSON.stringify(args).slice(0, 200),
          });
        },
        onToolResult: (toolCallId, content, isError) => {
          send({
            type: "toolResult",
            toolCallId,
            content: content.slice(0, 2000),
            isError,
          });
        },
      })) {
        // Chunks streamed via onText callback above
      }

      // Save session
      session.updatedAt = Date.now();
      saveSession(session);

      send({ type: "done", sessionId: session.id, cwd: session.cwd });
    } catch (e: any) {
      if (e.name === "AbortError" || abortController.signal.aborted) {
        send({ type: "done", sessionId: session.id, aborted: true });
      } else {
        send({ type: "error", message: e.message || "Unknown error" });
      }
    } finally {
      res.end();
    }
  });

  return app;
}

// ─── Entry Point (when run directly) ──────────────────

export function startServer(port = 4200): void {
  const app = createApp();
  app.listen(port, () => {
    console.log("");
    console.log("  ⚒  Forge — AI Coding Agent");
    console.log(`  Webapp running at http://localhost:${port}/`);
    console.log("");
  });
}

// Run if called directly
const isMain = process.argv[1]?.includes("server");
if (isMain) {
  const port = parseInt(process.env.FORGE_PORT || process.argv[2] || "4200", 10);
  startServer(port);
}