"""Social channel publishers (PRD §15, FR-10.2).

LinkedIn (UGC Posts API) and Reddit (submit API). Both mirror the WordPress
adapter's contract: with valid credentials they make the real REST call; without
them they perform **no network call** and return a ``would_publish`` dry run, so
the flow works end-to-end before any OAuth is wired. Never raises — transport
errors are returned as ``{"status": "error", ...}``.
"""

from __future__ import annotations


def linkedin_publish(content: dict, creds: dict | None = None) -> dict:
    """Publish a text post to LinkedIn via the UGC Posts API.

    ``creds``: ``{access_token, author_urn}`` (author_urn like
    ``urn:li:person:xxxx`` or ``urn:li:organization:xxxx``).
    """
    creds = creds or {}
    token = creds.get("access_token")
    author = creds.get("author_urn")
    text = (content or {}).get("text", "")

    payload = {
        "author": author or "urn:li:person:UNSET",
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": {"text": text},
                "shareMediaCategory": "NONE",
            }
        },
        "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
    }

    if not (token and author):
        return {
            "status": "would_publish",
            "channel": "linkedin",
            "note": "No LinkedIn credentials — dry run. Set LINKEDIN_ACCESS_TOKEN + LINKEDIN_AUTHOR_URN to post live.",
            "preview": text,
        }

    import httpx

    try:
        resp = httpx.post(
            "https://api.linkedin.com/v2/ugcPosts",
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "X-Restli-Protocol-Version": "2.0.0",
                "Content-Type": "application/json",
            },
            timeout=30,
        )
        resp.raise_for_status()
        post_id = resp.headers.get("x-restli-id") or (resp.json() or {}).get("id")
        return {"status": "published", "channel": "linkedin", "id": post_id}
    except Exception as exc:  # noqa: BLE001 - surface transport/API error
        return {"status": "error", "channel": "linkedin", "error": str(exc)}


def reddit_publish(content: dict, creds: dict | None = None) -> dict:
    """Submit a self-post to Reddit via the OAuth submit API.

    ``creds``: ``{access_token, user_agent}``. ``content``:
    ``{title, body, subreddit}``.
    """
    creds = creds or {}
    token = creds.get("access_token")
    user_agent = creds.get("user_agent") or "ContentOS/1.0"
    content = content or {}
    # Strip an optional "r/" prefix — but NOT with lstrip("r/"), which strips any
    # leading run of {'r','/'} and mangles names like "react" -> "eact".
    _sub_raw = (content.get("subreddit") or creds.get("subreddit") or "").strip()
    subreddit = _sub_raw[2:] if _sub_raw.lower().startswith("r/") else _sub_raw.lstrip("/")
    title = content.get("title", "")
    body = content.get("body", "")

    if not (token and subreddit):
        return {
            "status": "would_publish",
            "channel": "reddit",
            "note": "No Reddit credentials/subreddit — dry run. Set REDDIT_ACCESS_TOKEN + a subreddit to post live.",
            "preview": {"subreddit": subreddit, "title": title, "body": body},
        }

    import httpx

    try:
        resp = httpx.post(
            "https://oauth.reddit.com/api/submit",
            data={"sr": subreddit, "kind": "self", "title": title, "text": body, "api_type": "json"},
            headers={"Authorization": f"Bearer {token}", "User-Agent": user_agent},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        errors = (((data or {}).get("json") or {}).get("errors")) or []
        if errors:
            return {"status": "error", "channel": "reddit", "error": str(errors)}
        url = (((data or {}).get("json") or {}).get("data") or {}).get("url")
        return {"status": "published", "channel": "reddit", "link": url}
    except Exception as exc:  # noqa: BLE001 - surface transport/API error
        return {"status": "error", "channel": "reddit", "error": str(exc)}
