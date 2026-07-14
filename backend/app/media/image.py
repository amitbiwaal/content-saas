"""Featured-image generation for an article (PRD §7 assets).

Generates a 16:9 hero image from the project brief. Uses OpenAI image generation
(``dall-e-3`` at 1792x1024, the closest native landscape to 16:9) when an OpenAI
key is configured; otherwise it returns a deterministic, on-brand SVG placeholder
so the feature works with zero keys (the same "mock adapter" contract the rest of
the pipeline follows). Never raises: any provider error degrades to the SVG.
"""

from __future__ import annotations

import base64
import html

from app.config import get_settings


def build_image_prompt(brief: dict, extra: str = "") -> str:
    """A clean, brand-safe editorial hero prompt derived from the brief."""
    topic = (brief.get("topic") or brief.get("keyword") or "the topic").strip()
    audience = (brief.get("audience") or "").strip()
    base = (
        f"A modern, clean 16:9 editorial hero image for an article about \"{topic}\". "
        "Professional, minimal, high quality, soft depth of field, tasteful lighting. "
        "No text, no words, no watermark, no logos."
    )
    if audience:
        base += f" Visual tone suited to {audience}."
    if extra.strip():
        base += f" {extra.strip()}"
    return base


def default_alt(brief: dict) -> str:
    topic = (brief.get("topic") or brief.get("keyword") or "Featured image").strip()
    return f"Featured image for {topic}"


def generate_image(prompt: str) -> tuple[bytes, str]:
    """Return ``(bytes, ext)`` for a generated 16:9 image.

    Tries OpenAI ``dall-e-3`` (1792x1024); on any failure or missing key, falls
    back to a deterministic SVG placeholder (ext ``svg``).
    """
    settings = get_settings()
    if settings.openai_api_key:
        try:
            import openai

            client = openai.OpenAI(api_key=settings.openai_api_key)
            # gpt-image-1 (OpenAI's current image model). It always returns
            # base64 and rejects the legacy ``response_format`` param, so we omit
            # it. 1536x1024 is its widest landscape; the UI crops it to 16:9.
            resp = client.images.generate(
                model=settings.openai_image_model or "gpt-image-1",
                prompt=prompt,
                size="1536x1024",
                n=1,
            )
            item = resp.data[0]
            b64 = getattr(item, "b64_json", None)
            if b64:
                return base64.b64decode(b64), "png"
            url = getattr(item, "url", None)
            if url:
                import httpx

                return httpx.get(url, timeout=60).content, "png"
        except Exception:  # noqa: BLE001 - degrade to placeholder, never break
            pass
    return _placeholder_svg(prompt), "svg"


def _placeholder_svg(prompt: str) -> bytes:
    """A 16:9 aurora-gradient placeholder with the prompt's subject wrapped in.

    Deterministic + dependency-free so the featured-image flow works offline and
    reads on-brand (dark aurora) until a real image key is supplied.
    """
    # Pull a short subject line out of the prompt (between the quotes if present).
    subject = prompt
    if '"' in prompt:
        try:
            subject = prompt.split('"', 2)[1]
        except IndexError:
            subject = prompt
    subject = subject.strip()[:90] or "Featured image"

    lines = _wrap(subject, 26)[:3]
    tspans = "".join(
        f'<tspan x="800" dy="{0 if i == 0 else 64}">{html.escape(line)}</tspan>'
        for i, line in enumerate(lines)
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1600" y2="900" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#04120d"/>
      <stop offset="0.5" stop-color="#0a2a1f"/>
      <stop offset="1" stop-color="#05171a"/>
    </linearGradient>
    <radialGradient id="orb" cx="0.7" cy="0.3" r="0.6">
      <stop offset="0" stop-color="#10b981" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect width="1600" height="900" fill="url(#orb)"/>
  <circle cx="240" cy="720" r="360" fill="#22d3ee" opacity="0.12"/>
  <text x="800" y="420" fill="#eafff5" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="800" text-anchor="middle">{tspans}</text>
  <text x="800" y="820" fill="#6ee7b7" font-family="Inter, Arial, sans-serif" font-size="24" letter-spacing="3" text-anchor="middle">CONTENTOS AI · PLACEHOLDER (add OPENAI_API_KEY for a real image)</text>
</svg>"""
    return svg.encode("utf-8")


def _wrap(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines
