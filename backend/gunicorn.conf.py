"""Gunicorn config for the ContentOS backend (production entrypoint).

Runs Uvicorn workers under the gunicorn master so crashed workers are restarted
and multiple cores are used. Tune WEB_CONCURRENCY per deployment.
"""

import os

bind = f"0.0.0.0:{os.getenv('PORT', '8000')}"
worker_class = "uvicorn.workers.UvicornWorker"
workers = int(os.getenv("WEB_CONCURRENCY", str((os.cpu_count() or 1) * 2 + 1)))
# Long timeout so streaming pipeline runs (SSE) aren't killed mid-flight.
timeout = int(os.getenv("GUNICORN_TIMEOUT", "120"))
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = os.getenv("LOG_LEVEL", "info").lower()
