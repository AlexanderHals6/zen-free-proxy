// Node 18+ entry — for VPS / Render / Railway / Miget and local use.
// Start: node platforms/node.js   (PORT and the vars in README apply)
import http from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { handleRequest } from "../proxy.js";

// Builds the Node HTTP server without binding it, so the adapter can be
// mounted in tests or inside another app.
export function createServer(env = process.env) {
  return http.createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host || "localhost"}${req.url}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined,
      });
      const response = await handleRequest(request, { env });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return res.end();
      Readable.fromWeb(response.body).pipe(res);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String((err && err.message) || err), type: "proxy_error" } }));
    }
  });
}

// Auto-start only when executed directly, not when imported.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  createServer().listen(port, host, () => {
    console.log(`zen-free-proxy listening on http://${host}:${port}`);
  });
}
