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
  // Dev BFF: proxy API + health to FastAPI so the browser uses relative paths
  // and never sees the backend origin directly. Swap for Next route handlers
  // (app/api/**) once auth/session is added.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
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
              // Backend API + (dev only) the HMR websocket.
              `connect-src 'self' ${BACKEND}${isDev ? " ws://localhost:3000 ws://127.0.0.1:3000" : ""}`,
              "img-src 'self' data:",
              // Google Fonts: the Sora stylesheet (@import in globals.css) +
              // the font files it pulls from gstatic.
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              // Next dev needs 'unsafe-eval' for HMR/Fast Refresh; prod stays strict.
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
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
