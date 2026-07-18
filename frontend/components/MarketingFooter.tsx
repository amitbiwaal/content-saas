"use client";

// Full marketing footer — the same one the landing page uses, shared across
// About, Contact and the legal pages so every public page ends identically.
// Section links point at "/#id" so they jump to the landing sections from any
// sub-page (and still scroll in place when already on the homepage).
export default function MarketingFooter() {
  return (
    <footer className="lp-ft">
      <div className="lp-ft-inner">
        <div className="lp-ft-cta fade-in">
          <div className="lp-ft-cta-copy">
            <span className="lp-eyebrow">
              <span className="lp-eyebrow-dot" />
              GET STARTED
              <span className="lp-eyebrow-tag">FREE BRIEF</span>
            </span>
            <h2 className="lp-ft-cta-title">
              One brief. Four models.{" "}
              <span className="lp-ft-cta-grad">Publish-ready in minutes.</span>
            </h2>
            <p className="lp-ft-cta-sub">
              Run a single brief through OpenAI, Claude, Gemini and Grok at once,
              let the Judge resolve every conflict, and export to WordPress in one click.
            </p>
          </div>
          <div className="lp-ft-cta-actions">
            <a className="lp-btn-primary" href="/pricing">Start free</a>
            <a className="lp-btn-ghost" href="/#how">See how it works</a>
          </div>
        </div>

        <div className="lp-ft-top">
          <div className="lp-ft-brand">
            <a href="/" className="lp-ft-logo" aria-label="ContentOS AI home">
              <span className="lp-ft-mark" aria-hidden="true">C</span>
              <span className="lp-ft-name">
                ContentOS<span className="lp-ft-name-ai">AI</span>
              </span>
            </a>
            <p className="lp-ft-tagline">
              The multi-model content engine. A council of AIs debates, a Judge decides,
              and every article passes an 8-score gate before it ships.
            </p>
            <div className="lp-ft-social" aria-label="Social links">
              <a className="lp-ft-social-link" href="/contact" aria-label="ContentOS AI on X">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 4l16 16" />
                  <path d="M20 4L4 20" />
                </svg>
              </a>
              <a className="lp-ft-social-link" href="/contact" aria-label="ContentOS AI on GitHub">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 22v-4a3 3 0 0 0-.9-2.3c3-.3 6.1-1.5 6.1-6.6a5.1 5.1 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.6 12.6 0 0 0-6.6 0C6.3 1.7 5.2 2 5.2 2a4.8 4.8 0 0 0-.1 3.6A5.1 5.1 0 0 0 3.7 9.2c0 5.1 3.1 6.3 6.1 6.6A3 3 0 0 0 9 18v4" />
                  <path d="M9 19c-4 1.4-4-1.8-6-2" />
                </svg>
              </a>
              <a className="lp-ft-social-link" href="/contact" aria-label="ContentOS AI on LinkedIn">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <path d="M7 10v7" />
                  <path d="M7 7.01V7" />
                  <path d="M11 17v-4a2 2 0 0 1 4 0v4" />
                  <path d="M11 17v-7" />
                </svg>
              </a>
            </div>
          </div>

          {/* Careers/Docs/Blog/Changelog/Status + the social icons route to
              /contact for now — repoint each to its real page/handle when it
              exists (they were dead "#" anchors before). */}
          <nav className="lp-ft-cols" aria-label="Footer">
            <div className="lp-ft-col">
              <h3 className="lp-ft-col-title">Product</h3>
              <ul className="lp-ft-list">
                <li><a className="lp-ft-link" href="/#how">How it works</a></li>
                <li><a className="lp-ft-link" href="/#council">The Council</a></li>
                <li><a className="lp-ft-link" href="/#scoring">Scoring gate</a></li>
                <li><a className="lp-ft-link" href="/#publish">WordPress export</a></li>
                <li><a className="lp-ft-link" href="/pricing">Pricing</a></li>
              </ul>
            </div>

            <div className="lp-ft-col">
              <h3 className="lp-ft-col-title">Company</h3>
              <ul className="lp-ft-list">
                <li><a className="lp-ft-link" href="/about">About</a></li>
                <li><a className="lp-ft-link" href="/contact">Careers</a></li>
                <li><a className="lp-ft-link" href="/contact">Contact</a></li>
              </ul>
            </div>

            <div className="lp-ft-col">
              <h3 className="lp-ft-col-title">Resources</h3>
              <ul className="lp-ft-list">
                <li><a className="lp-ft-link" href="/contact">Docs</a></li>
                <li><a className="lp-ft-link" href="/contact">Blog</a></li>
                <li><a className="lp-ft-link" href="/contact">Changelog</a></li>
                <li><a className="lp-ft-link" href="/contact">Status</a></li>
              </ul>
            </div>

            <div className="lp-ft-col">
              <h3 className="lp-ft-col-title">Legal</h3>
              <ul className="lp-ft-list">
                <li><a className="lp-ft-link" href="/privacy">Privacy</a></li>
                <li><a className="lp-ft-link" href="/terms">Terms</a></li>
                <li><a className="lp-ft-link" href="/cookies">Cookies</a></li>
                <li><a className="lp-ft-link" href="/contact">Contact</a></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="lp-ft-bottom">
          <p className="lp-ft-copy">© 2026 ContentOS AI. Built by Tech Savy Crew.</p>
          <a className="lp-ft-status" href="/contact">
            <span className="lp-ft-status-dot" aria-hidden="true" />
            <span className="lp-ft-status-label">All systems normal</span>
          </a>
          <ul className="lp-ft-legal">
            <li><a className="lp-ft-legal-link" href="/privacy">Privacy</a></li>
            <li aria-hidden="true" className="lp-ft-legal-sep">·</li>
            <li><a className="lp-ft-legal-link" href="/terms">Terms</a></li>
            <li aria-hidden="true" className="lp-ft-legal-sep">·</li>
            <li><a className="lp-ft-legal-link" href="/cookies">Cookies</a></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
