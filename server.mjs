// Vercel entrypoint.
//
// Vercel detects a `server` entrypoint in the project root, calls
// `server.listen()` during startup, and routes every request to that Node
// HTTP server through an internal port. Reusing the same server the
// self-hosted adapter builds keeps one request path across every platform and
// avoids rewrite-based path mapping entirely: the core's own routing for
// /v1/chat/completions, /v1/models, and /healthz stays authoritative.
//
// The Node.js runtime is Vercel's recommended target over Edge, and it
// streams responses natively, which the SSE relay depends on.
import { createServer } from "./platforms/node.js";

const server = createServer(process.env);
server.listen(Number(process.env.PORT ?? 3000));
