// Streaming BFF for the live pipeline SSE. A Next Route Handler (Node runtime)
// proxies straight to the FastAPI backend and passes the response body through
// unbuffered, so live streaming works same-origin in production without the
// buffering /api rewrite and without exposing the backend origin to the browser.
//
// In dev the client connects directly to the backend (NEXT_PUBLIC_STREAM_ORIGIN);
// in prod that var is unset and EventSource hits this relative path instead.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  // Forward the shared API key server-side so the backend gate is satisfied
  // without ever exposing the key to the browser.
  if (process.env.API_KEY) headers["X-API-Key"] = process.env.API_KEY;

  // Forward the run params (?gated=1, ?from=<stage>) so gated review and
  // resume-after-approval work in prod, where EventSource hits this route
  // instead of connecting straight to the backend.
  const search = new URL(req.url).search;
  const upstream = await fetch(
    `${BACKEND}/api/projects/${encodeURIComponent(id)}/run/stream${search}`,
    { headers, cache: "no-store" },
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
