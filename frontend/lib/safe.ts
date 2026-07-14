// Allow only navigable, non-script URL schemes. Model-generated content is
// rendered throughout the app, so link/image targets must be validated to block
// javascript:/data:/vbscript: URLs (XSS). Returns the URL when safe, else null.
export function safeHref(url: string | undefined | null): string | null {
  const u = (url ?? "").trim();
  return /^(https?:|mailto:|\/|#)/i.test(u) ? u : null;
}
