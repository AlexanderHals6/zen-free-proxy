// OpenCode Zen free-tier proxy — portable core.
//
// Zero dependencies, Web-standard Request/Response only. Runs unchanged on
// Cloudflare Workers, Deno Deploy, Vercel Edge Functions, and Node 18+
// (Miget/Render/VPS) via the thin adapters in ./platforms and ./api.
//
// What it does per chat request (all required by the Zen free tier,
// verified live 2026-09-28):
//   1. Rewrites User-Agent to an opencode client UA (else 403 FreeTierError).
//   2. Forces stream:true and merges the 5 core agent tools
//      (bash/edit/glob/grep/read) into the body (else 403 FreeTierError).
//   3. Canonicalizes the session id to the ses_<12 hex><14 base62> shape
//      the free tier requires (else 403).
//   4. Forwards to https://opencode.ai/zen/v1/chat/completions with
//      Authorization: Bearer public and relays the SSE stream.
//   5. If the client asked stream:false, collapses the stream back into a
//      single chat.completion JSON reply.

const DEFAULT_UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models";
const DEFAULT_UA = "opencode/1.18.31 (proxy; edge)";
const CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"];
const DEFAULT_FREE_MODELS = [
  "big-pickle",
  "space-bunny-free",
  "longcat-2.5-preview-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "ling-3.0-flash-fin-free",
];
const MAX_BODY = 32 << 20; // 32 MiB
const DEFAULT_TIMEOUT_MS = 180000;
// Canonical OpenCode session shape: ses_ + 12 lowercase hex + 14 base62.
const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// --- env ---------------------------------------------------------------

// Reads from the per-runtime env bag (ctx.env), falling back to process.env
// for Node-style runtimes.
function envOf(ctx, name, fallback) {
  const bag = (ctx && ctx.env) || {};
  let v = bag[name];
  if (v === undefined || v === null) {
    const p = typeof process !== "undefined" && process.env ? process.env : null;
    v = p ? p[name] : undefined;
  }
  return v === undefined || v === null || v === "" ? fallback : v;
}

// --- small helpers -------------------------------------------------------

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-api-key, x-session-id, x-session-affinity, x-opencode-session, x-opencode-project, x-parent-session-id",
    "access-control-max-age": "86400",
  };
}

function jsonResponse(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

function proxyError(status, message) {
  return jsonResponse(status, { error: { message, type: "proxy_error" } });
}

// Constant-time-ish string compare; no length short-circuit for equal lengths.
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomID(prefix, length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += B62[b % 62];
  return prefix + s;
}

// Deterministically canonicalize any session signal into the ses_ shape the
// free tier demands; real OpenCode sessions pass through untouched.
async function canonicalSession(signal) {
  let bytes;
  if (!signal) {
    bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
  } else if (CANONICAL_SESSION.test(signal)) {
    return signal;
  } else {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zen-free:" + signal));
    bytes = new Uint8Array(digest).slice(0, 20);
  }
  let hex = "";
  for (let i = 0; i < 6; i++) hex += bytes[i].toString(16).padStart(2, "0");
  let b62 = "";
  for (let i = 6; i < 20; i++) b62 += B62[bytes[i] % 62];
  return "ses_" + hex + b62;
}

// --- request shaping ------------------------------------------------------

function toolName(item) {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const fn = item.function;
    if (fn && typeof fn.name === "string") return fn.name;
    if (typeof item.name === "string") return item.name;
  }
  return null;
}

function minimalTool(name) {
  return {
    type: "function",
    function: { name, description: `OpenCode core tool ${name}`, parameters: { type: "object", properties: {} } },
  };
}

// Forces the agent shape the Zen free tier accepts: stream on plus all five
// core tools present. Existing client tools are kept; only missing names are
// appended with minimal definitions.
function ensureAgentShape(body) {
  const out = { ...body };
  out.stream = true;
  if (out.stream_options === undefined) out.stream_options = { include_usage: true };
  const tools = Array.isArray(out.tools) ? out.tools.filter(Boolean) : [];
  const names = new Set(tools.map(toolName));
  const missing = CORE_TOOLS.filter((n) => !names.has(n));
  if (missing.length) out.tools = [...tools, ...missing.map(minimalTool)];
  return out;
}

function bearerOf(request) {
  const auth = request.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.slice(7).trim();
  const key = request.headers.get("x-api-key");
  return key ? key.trim() : "";
}

function sessionSignal(request, body) {
  return (
    request.headers.get("x-session-id") ||
    request.headers.get("x-opencode-session") ||
    request.headers.get("x-session-affinity") ||
    (body && body.metadata && (body.metadata.session_id || body.metadata.sessionId)) ||
    ""
  );
}

async function readBody(request) {
  const reader = request.body ? request.body.getReader() : null;
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) return null;
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(out);
}

// --- stream collapsing ----------------------------------------------------

// Reassembles a chat.completion JSON reply from an SSE stream (used when the
// client asked for a plain JSON body but the free tier only serves streams).
function collapseSSE(text) {
  let id = "";
  let model = "";
  let created = 0;
  let content = "";
  let finish = null;
  let usage = null;
  const toolCalls = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (!chunk) continue;
    if (!id && chunk.id) id = chunk.id;
    if (!model && chunk.model) model = chunk.model;
    if (!created && chunk.created) created = chunk.created;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) {
      if (chunk.usage) usage = chunk.usage;
      continue;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolCalls.get(idx) || { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function) {
          if (typeof tc.function.name === "string") cur.name += tc.function.name;
          if (typeof tc.function.arguments === "string") cur.args += tc.function.arguments;
        }
        toolCalls.set(idx, cur);
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const message = { role: "assistant", content: content || null };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, t]) => ({
        index,
        id: t.id || `call_${index}`,
        type: "function",
        function: { name: t.name, arguments: t.args || "{}" },
      }));
  }
  return {
    id: id || randomID("chatcmpl_", 8),
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish || "stop", logprobs: null }],
    usage: usage || null,
  };
}

// A non-SSE body (some upstream errors, or a JSON reply that ignored
// stream:true) is returned as-is instead of being collapsed into an empty
// completion.
function normalizeReply(text, contentType) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.object === "chat.completion") return parsed;
    } catch {
      /* fall through to SSE parsing */
    }
  }
  return collapseSSE(text);
}

// Guards the wait for response headers only. The timer is cleared once the
// upstream starts responding so a long generation is never cut mid-stream.
function headerTimeout(ms) {
  const n = Number(ms) || DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), n);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

// --- routes ---------------------------------------------------------------

function modelsResponse(ctx) {
  const raw = envOf(ctx, "FREE_MODELS");
  const ids = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_FREE_MODELS;
  return jsonResponse(200, {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "opencode" })),
  });
}

export async function handleRequest(request, ctx = {}) {
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  const url = new URL(request.url);
  const path = url.pathname;

  if (method === "GET" && (path === "/healthz" || path === "/health")) {
    return jsonResponse(200, { ok: true });
  }

  if (path !== "/v1/chat/completions" && path !== "/v1/models") {
    return proxyError(404, "not found");
  }

  const key = envOf(ctx, "PROXY_KEY", "");
  if (!key) return proxyError(500, "PROXY_KEY is not configured");
  if (!timingSafeEqualStr(bearerOf(request), key)) return proxyError(401, "invalid api key");

  if (method === "GET" && path === "/v1/models") return modelsResponse(ctx);
  if (path === "/v1/models") return proxyError(405, "method not allowed");
  if (method !== "POST") return proxyError(405, "method not allowed");

  const raw = await readBody(request);
  if (raw === null) return proxyError(413, "request body too large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return proxyError(400, "invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return proxyError(400, "invalid JSON body");
  if (!body.model) return proxyError(400, "model is required");

  const wantStream = body.stream === true;
  const upstreamBody = ensureAgentShape(body);
  const session = await canonicalSession(sessionSignal(request, body));
  const upstream = envOf(ctx, "UPSTREAM_URL", DEFAULT_UPSTREAM);

  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": envOf(ctx, "UA", DEFAULT_UA),
    authorization: "Bearer public",
    "x-opencode-client": "cli",
    "x-opencode-session": session,
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-request": randomID("req_", 16),
  };
  const parent = request.headers.get("x-parent-session-id");
  if (parent) headers["x-parent-session-id"] = parent;
  const project = request.headers.get("x-opencode-project");
  if (project) headers["x-opencode-project"] = project;

  const hdrGuard = headerTimeout(envOf(ctx, "TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: hdrGuard.signal,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return proxyError(504, `upstream unreachable: ${msg.slice(0, 140)}`);
  } finally {
    hdrGuard.clear();
  }

  if (wantStream) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        "content-type": upstreamRes.headers.get("content-type") || "text/event-stream",
        ...corsHeaders(),
      },
    });
  }

  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    try {
      return new Response(JSON.stringify(JSON.parse(text)), {
        status: upstreamRes.status,
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    } catch {
      return new Response(text, { status: upstreamRes.status, headers: corsHeaders() });
    }
  }
  return jsonResponse(200, normalizeReply(text));
}