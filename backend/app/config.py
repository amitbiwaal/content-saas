"""Environment-driven application settings.

Every tunable lives here so nothing is hardcoded in logic (PRD §12). Provider
keys are optional — a seat without a key falls back to the deterministic mock
adapter, so the whole pipeline runs end-to-end with zero API spend.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- App ---
    app_env: str = "dev"
    # Default to the Next.js dev origin (port 3000). The SSE stream connects
    # straight to the backend, so this origin must be allowed for live runs.
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Comma-separated Host header allow-list enforced in prod (TrustedHost).
    # Empty => allow any host (dev default).
    allowed_hosts: str = ""
    log_level: str = "INFO"

    # --- Auth (opt-in) ---
    # When set, every route except health/readiness/docs requires this key in
    # the ``X-API-Key`` header. Left blank the API is open (local-dev default).
    api_key: str = ""

    # --- Provider transport (PRD §12/§13 resilience) ---
    provider_timeout_s: float = 60.0   # per-request timeout for every LLM call
    provider_max_retries: int = 1      # SDK-level retries before failover

    # --- Database ---
    database_url: str = "sqlite:///./contentos.db"

    # --- Provider keys (blank => seat uses the mock adapter) ---
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    google_api_key: str = ""
    xai_api_key: str = ""

    # --- Per-seat model overrides (blank => registry default) ---
    anthropic_model: str = ""
    openai_model: str = ""
    google_model: str = ""
    xai_model: str = ""

    # --- Featured-image generation (OpenAI images API) ---
    openai_image_model: str = "gpt-image-1"

    # --- Research ---
    research_provider: str = "mock"  # ahrefs | mock
    ahrefs_api_key: str = ""

    # --- Cost & budget (PRD §13); cents ---
    monthly_budget_cents: float = 50000.0      # $500/mo default cap
    per_article_ceiling_cents: float = 2000.0  # $20/article ceiling -> downgrade

    # --- Integrations (PRD §15) ---
    wordpress_url: str = ""          # e.g. https://blog.example.com
    wordpress_username: str = ""
    wordpress_app_password: str = ""  # WordPress application password
    google_oauth_token: str = ""      # Google OAuth access token for Docs export

    # --- Social distribution (PRD §15) — blank => dry run ---
    linkedin_access_token: str = ""   # OAuth token with w_member_social
    linkedin_author_urn: str = ""     # urn:li:person:xxx or urn:li:organization:xxx
    reddit_access_token: str = ""     # OAuth bearer token (submit scope)
    reddit_user_agent: str = "ContentOS/1.0"
    reddit_default_subreddit: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def allowed_host_list(self) -> list[str]:
        return [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]

    @property
    def is_prod(self) -> bool:
        return self.app_env.lower() in {"prod", "production"}

    @model_validator(mode="after")
    def _guard_prod(self) -> "Settings":
        """Fail fast on unsafe production configuration."""
        if self.is_prod:
            if self.database_url.startswith("sqlite"):
                raise ValueError(
                    "APP_ENV=prod requires a non-SQLite DATABASE_URL (e.g. Postgres)."
                )
            if not self.api_key:
                raise ValueError("APP_ENV=prod requires API_KEY to be set.")
        return self


@lru_cache
def get_settings() -> Settings:
    """Cached singleton — import and call this everywhere settings are needed."""
    return Settings()
