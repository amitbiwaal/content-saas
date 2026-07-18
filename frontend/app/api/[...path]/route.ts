// Server-side BFF proxy for every /api/* call. A Next Route Handler (Node
// runtime) forwards the browser's request to the FastAPI backend and injects the
// shared `X-API-Key` server-side, so the production auth gate is satisfied
// without ever exposing the key to the browser. It replaces the old transparent
// `/api/:path*` rewrite in next.config.mjs, which could not add a request header.
//
// The more-specific SSE stream handler (app/api/projects/[id]/run/stream) takes
// precedence over this catch-all, so live streaming keeps its dedicated route.
//
// Body and response are passed through faithfully (JSON, binary images, file
// downloads) so /image and /export endpoints keep working through the proxy.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000";

// Response headers worth preserving from the upstream (content type + downloads).
// content-length is intentionally dropped: the body is re-streamed, so we let the
// runtime frame it (chunked) rather than risk a stale length.
const PASS_THROUGH = ["content-type", "content-disposition", "cache-control"];

async function proxy(req: Request, path: string[]): Promise<Response> {
  const search = new URL(req.url).search;
  const target = `${BACKEND}/api/${path.map(encodeURIComponent).join("/")}${search}`;

  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  // Forward the user's Bearer token so the backend can identify the account.
  const authz = req.headers.get("authorization");
  if (authz) headers.set("authorization", authz);
  if (process.env.API_KEY) headers.set("X-API-Key", process.env.API_KEY);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    cache: "no-store",
    redirect: "manual",
  });

  const resHeaders = new Headers();
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) resHeaders.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
