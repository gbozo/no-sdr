// Public Worker entry point.
//
// Routes:
//   GET/Upgrade /ingest/:instance/:dongle       bearer INGEST_TOKEN (origin)
//   GET/Upgrade /v1/:instance/:dongle/fft       public viewer feed
//   GET         /health                         no secrets
//   GET         /stats/:instance/:dongle        bearer INGEST_TOKEN
//
// The Worker validates and authenticates before touching the DO, so invalid
// requests do not consume Durable Object requests.

import { Fanout } from "./fanout";

export { Fanout };

export interface Env {
  FANOUT: DurableObjectNamespace<Fanout>;
  INGEST_TOKEN: string;
  MAX_VIEWERS?: string;
  EDGE_VERSION?: string;
  ALLOWED_ORIGIN?: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCors(
        env,
        json({
          ok: true,
          version: env.EDGE_VERSION ?? "dev",
          maxViewers: Number(env.MAX_VIEWERS ?? 200),
          now: Date.now(),
        }),
      );
    }

    if (request.method === "OPTIONS") {
      return withCors(env, new Response(null, { status: 204 }));
    }

    const stats = url.pathname.match(/^\/stats\/([^/]+)\/([^/]+)$/);
    if (stats) {
      const [, instance, dongle] = stats;
      if (!validName(instance) || !validName(dongle)) {
        return withCors(env, json({ error: "invalid route" }, 400));
      }
      if (!authorized(request, env.INGEST_TOKEN)) {
        return withCors(env, json({ error: "forbidden" }, 403));
      }

      const stub = env.FANOUT.get(env.FANOUT.idFromName(`${instance}:${dongle}`));
      const response = await stub.fetch("https://do/stats");
      return withCors(env, response);
    }

    const route = url.pathname.match(/^\/(ingest|v1)\/([^/]+)\/([^/]+)(\/fft)?$/);
    if (!route) return json({ error: "not found" }, 404);

    const [, kind, instance, dongle, fftSuffix] = route;
    if (!validName(instance) || !validName(dongle)) {
      return json({ error: "invalid instance or dongle" }, 400);
    }
    if (kind === "ingest" && fftSuffix) {
      return json({ error: "invalid ingest route" }, 404);
    }
    if (kind === "v1" && !fftSuffix) {
      return json({ error: "missing /fft" }, 404);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected websocket upgrade" }, 426);
    }
    if (kind === "ingest" && !authorized(request, env.INGEST_TOKEN)) {
      return json({ error: "forbidden" }, 403);
    }

    const headers = new Headers(request.headers);
    headers.set("x-nosdr-role", kind === "ingest" ? "ingest" : "viewer");
    headers.set("x-nosdr-instance", instance);
    headers.set("x-nosdr-dongle", dongle);

    const stub = env.FANOUT.get(env.FANOUT.idFromName(`${instance}:${dongle}`));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

function validName(value: string): boolean {
  return NAME_RE.test(value);
}

function authorized(request: Request, expected: string): boolean {
  if (!expected) return false;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice("Bearer ".length), expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function withCors(env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
