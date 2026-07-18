/** @type {import('next').NextConfig} */

// Backend (FastAPI) base URL. In prod set BACKEND_ORIGIN to the service URL.
const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000";

// `next dev` (webpack HMR + React Fast Refresh) evaluates modules via eval() and
// opens an HMR websocket, so the CSP must allow 'unsafe-eval' and ws: in dev.
// Production keeps the strict policy (no eval, no ws).
const isDev = process.env.NODE_ENV !== "production";

const nextConfig = {
  // Hide the floating dev-tools indicator for a clean UI while developing.
  devIndicators: false,
  // /api/* is proxied by a server-side Route Handler (app/api/[...path]/route.ts)
  // that injects the X-API-Key so the prod auth gate is satisfied — a rewrite
  // cannot add a request header. Only /health (public, keyless) stays a rewrite.
  async rewrites() {
    return [
      { source: "/health", destination: `${BACKEND}/health` },
    ];
  },
  // Baseline security headers on every response (clickjacking / sniffing /
  // transport / referrer / a conservative CSP). Tune the CSP if you add CDNs.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Backend API + (dev only) the HMR websocket + Google Sign-In.
              `connect-src 'self' ${BACKEND} https://accounts.google.com${isDev ? " ws://localhost:3000 ws://127.0.0.1:3000" : ""}`,
              "img-src 'self' data: https://*.googleusercontent.com",
              // Google Fonts + Google Sign-In injected styles.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
              "font-src 'self' https://fonts.gstatic.com",
              // Next dev needs 'unsafe-eval'; Google Sign-In (GIS) loads gsi/client.
              `script-src 'self' 'unsafe-inline' https://accounts.google.com${isDev ? " 'unsafe-eval'" : ""}`,
              // GIS renders its button/one-tap in a Google-hosted iframe.
              "frame-src https://accounts.google.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
