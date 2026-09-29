// Vercel Function entrypoint.
//
// Vercel maps every URL onto this single function via a rewrite (see
// vercel.json). The original path is forwarded as the `path` query parameter
// (`?path=v1/models`), which is how Vercel preserves the source path when a
// rewrite lands on a single function. Some setups also hand the function the
// destination pathname; both cases are normalized here before the shared core
// is called, keeping the proxy's own routing authoritative on every platform.
import { handleRequest } from "../proxy.js";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const via = url.searchParams.get("path");

    // Prefer the captured original path when present.
    let pathname = via && via.length > 0 ? "/" + via.replace(/^\/+/, "") : url.pathname;
    if (pathname.includes("?")) pathname = pathname.split("?")[0];

    const host = request.headers.get("host") || "placeholder.invalid";
    const normalized = new Request(`https://${host}${pathname}`, request);
    return handleRequest(normalized, { env: process.env });
  },
};
