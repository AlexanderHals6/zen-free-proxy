// Vercel Edge Function entry.
// Any /v1/* path is rewritten here by vercel.json.
import { handleRequest } from "../proxy.js";

export const config = { runtime: "edge" };

export default function handler(request) {
  return handleRequest(request, { env: process.env });
}
