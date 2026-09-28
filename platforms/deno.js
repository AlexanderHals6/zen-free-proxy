// Deno Deploy entry.
// Deploy: deploy this file (or the repo) at https://dash.deno.com, or
//   deployctl deploy --project=<name> platforms/deno.js
import { handleRequest } from "../proxy.js";

const env = { ...Deno.env.toObject() };
Deno.serve((request) => handleRequest(request, { env }));
