"""FastAPI application entrypoint.

Wires CORS, routers, and dev-time table creation. Run with:

    uvicorn app.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import __version__
from app.analytics.router import router as analytics_router
from app.auth import require_auth
from app.article.router import router as article_router
from app.compliance.router import router as compliance_router
from app.config import get_settings
from app.db import SessionLocal, engine, init_db
from app.distribute.router import router as distribute_router
from app.export.router import router as export_router
from app.factcheck.router import router as factcheck_router
from app.media.router import router as media_router
from app.translate.router import router as translate_router
from app.integrations import router as integrations_router
from app.memory_engine.router import router as memory_router
from app.outline.router import router as outline_router
from app.pipeline.router import router as pipeline_router
from app.providers.registry import REGISTRY
from app.research.router import router as research_router
from app.review.router import router as review_router
from app.routers import projects
from app.scoring.router import router as scoring_router

settings = get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("contentos")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev convenience: auto-create tables (no-op in prod; see app.db.init_db).
    # Prod schema is managed by Alembic (`alembic upgrade head`).
    init_db()
    try:
        yield
    finally:
        # Graceful shutdown: dispose the connection pool.
        engine.dispose()


app = FastAPI(
    title="ContentOS AI",
    version=__version__,
    description="Multi-model AI content engine — council debate, judge, publish gate.",
    lifespan=lifespan,
    # App-wide opt-in API-key gate (open when no API_KEY is configured).
    dependencies=[Depends(require_auth)],
)

# Host allow-list (prod): reject Host headers not in ALLOWED_HOSTS.
if settings.allowed_host_list:
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=settings.allowed_host_list
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log the full error server-side; return a generic message to the client.

    Prevents internal exception detail (paths, DB/provider internals) from
    leaking to unauthenticated callers.
    """
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})

app.include_router(projects.router)
app.include_router(research_router)
app.include_router(review_router)
app.include_router(outline_router)
app.include_router(article_router)
app.include_router(scoring_router)
app.include_router(factcheck_router)
app.include_router(compliance_router)
app.include_router(export_router)
app.include_router(memory_router)
app.include_router(pipeline_router)
app.include_router(integrations_router)
app.include_router(analytics_router)
app.include_router(media_router)
app.include_router(distribute_router)
app.include_router(translate_router)


@app.get("/health", tags=["meta"])
def health() -> dict:
    """Liveness probe — public, no config disclosure."""
    return {"status": "ok", "version": __version__}


@app.get("/ready", tags=["meta"])
def ready() -> JSONResponse:
    """Readiness probe — verifies DB connectivity so an LB can drain on outage."""
    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
    except Exception:
        logger.exception("readiness check failed")
        return JSONResponse(status_code=503, content={"status": "not-ready"})
    return JSONResponse(status_code=200, content={"status": "ready"})


@app.get("/api/status", tags=["meta"])
def status_detail() -> dict:
    """Detailed config/seat status — behind the API-key gate (not public)."""
    return {
        "status": "ok",
        "version": __version__,
        "env": settings.app_env,
        "providers": {
            name: {
                "model": info.model,
                "policy_tier": info.policy_tier.value,
                "key_configured": bool(getattr(settings, f"{name}_api_key", "")),
            }
            for name, info in REGISTRY.items()
        },
    }
