// Cloudflare Workers entry.
// Deploy: wrangler deploy   (see wrangler.toml)
import { handleRequest } from "../proxy.js";

export default {
  fetch(request, env) {
    return handleRequest(request, { env });
  },
};
