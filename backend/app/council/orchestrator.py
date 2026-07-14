"""Council orchestration & debate protocol (PRD §8.2).

Round 1 — Reports: every non-judge seat runs on identical research.
Round 2 — Debate: seats cross-critique; at least one real conflict is surfaced.
Round 3 — Judge: rules on each recommendation, emits strict JSON.

M0 ships a working skeleton end-to-end against the mock adapter. Each seat call
is refusal-aware: a :class:`ProviderRefusal` (or transport error) fails the seat
over to the next permissive-tier provider (PRD §11 routing, §12 failover).
"""

from __future__ import annotations

import itertools
import json
import queue
import re
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from app.providers import ProviderError, ProviderRefusal, get_adapter
from app.providers.base import AdapterResponse
from app.providers.registry import permissive_providers
from app.council.roles import DEFAULT_SEATS, JUDGE, ROLES, Role

_ROLE_BY_KEY: dict[str, Role] = {r.key: r for r in ROLES}

# Appended to a seat's system prompt so Round-1 output is parseable into discrete
# recommendations + a real confidence, while still reading well as it streams.
_REPORT_FORMAT = (
    "\n\nFormat your reply as 3 to 6 short recommendations, one per line, each "
    "starting with a number like '1.' (no sub-bullets, no preamble, no markdown "
    "headings or bold). After the list add a final line exactly like "
    "'Confidence: 0.82' — a single number between 0 and 1 for your overall "
    "confidence."
)

# Round-2 debate instruction appended to a seat's system prompt.
_CRITIQUE_FORMAT = (
    "\n\nRound 2 — debate. Read the OTHER council members' recommendations below. "
    "In 2 to 4 sentences, name the single most important disagreement, risk, or "
    "gap you see in their thinking and defend your own position. Be specific and "
    "concrete. Do not restate your own list."
)

_CONF_RE = re.compile(r"confidence\s*[:=]\s*([01](?:\.\d+)?|\.\d+|\d{1,3})", re.IGNORECASE)
_LIST_RE = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _parse_recommendations(text: str) -> tuple[list[str], float]:
    """Parse a seat's Round-1 reply into (recommendations, confidence).

    Pulls numbered/bulleted lines as discrete recommendations and reads the
    trailing ``Confidence: 0.xx`` line. Degrades gracefully: if the model didn't
    follow the format, every non-empty line (minus any confidence line) becomes a
    recommendation and confidence defaults to 0.7.
    """
    lines = text.splitlines()
    recs: list[str] = []
    confidence: float | None = None
    for line in lines:
        stripped = line.strip()
        conf_match = _CONF_RE.search(stripped)
        if conf_match and "confidence" in stripped.lower() and len(stripped) < 40:
            try:
                value = float(conf_match.group(1))
                confidence = value / 100 if value > 1 else value
            except ValueError:
                pass
            continue
        list_match = _LIST_RE.match(line)
        if list_match:
            rec = list_match.group(1).strip()
            if rec:
                recs.append(rec)
    if not recs:
        recs = [
            ln.strip() for ln in lines if ln.strip() and not _CONF_RE.search(ln)
        ] or [text.strip()]
    if confidence is None:
        confidence = 0.7
    return recs, round(max(0.0, min(1.0, confidence)), 2)


def _first_sentence(text: str, limit: int = 160) -> str:
    """First sentence of a critique, capped — used as a concise conflict summary."""
    first = _SENT_SPLIT_RE.split(text.strip(), maxsplit=1)[0].strip()
    return (first[: limit - 1] + "…") if len(first) > limit else first


@dataclass
class SeatReport:
    role: str
    provider: str
    model: str
    recommendations: list[str]
    confidence: float
    tokens: int
    routed_from: str | None = None  # set when failover changed the provider


@dataclass
class CouncilResult:
    reports: list[SeatReport] = field(default_factory=list)
    debate_messages: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    strategy_summary: str = ""
    total_tokens: int = 0


def _brief_text(brief: dict) -> str:
    text = (
        f"Topic: {brief.get('topic')}\n"
        f"Primary keyword: {brief.get('keyword')}\n"
        f"Country: {brief.get('country', 'US')}\n"
        f"Audience: {brief.get('audience') or 'general'}\n"
        f"Tone: {brief.get('tone') or 'neutral'}\n"
        f"Goal: {brief.get('goal') or 'rank and be cited'}\n"
        f"Research: {json.dumps(brief.get('research', {}))[:2000]}"
    )
    # Review mode: an editor rejected the prior council output and asked for a
    # re-run with this instruction — foreground it so every seat addresses it.
    feedback = (brief.get("feedback") or "").strip()
    if feedback:
        text += (
            f"\n\nEDITOR FEEDBACK (address this directly; the previous round was "
            f"rejected for it): {feedback[:1000]}"
        )
    return text


def _call_with_failover(
    provider: str, *, system: str, prompt: str, json_mode: bool = False
) -> tuple[AdapterResponse, str, str | None]:
    """Call a seat; on refusal/error fail over to permissive providers.

    Returns (response, provider_used, routed_from). ``routed_from`` is the
    original provider when failover changed it, else None.
    """
    tried: list[str] = []
    candidates = [provider] + [p for p in permissive_providers() if p != provider]
    last_err: Exception | None = None

    for candidate in candidates:
        try:
            resp = get_adapter(candidate).complete(
                system=system, prompt=prompt, json_mode=json_mode
            )
            routed_from = provider if candidate != provider else None
            return resp, candidate, routed_from
        except (ProviderRefusal, ProviderError) as exc:
            tried.append(candidate)
            last_err = exc
            continue

    raise ProviderError(
        f"all providers failed for seat (tried {tried}): {last_err}"
    )


def _stream_with_failover(
    provider: str, *, system: str, prompt: str, json_mode: bool = False
) -> Iterator[dict]:
    """Stream a seat's tokens, failing over to permissive providers on refusal.

    Yields:
        {"kind": "meta",  "provider": str, "model": str, "routed_from": str|None}
        {"kind": "delta", "delta": str}                     # per token/chunk
        {"kind": "done",  "response": AdapterResponse}       # terminal, with usage

    Failover only happens *before the first token* (refusals are pre-generation):
    once deltas start flowing we are committed to that provider, so the UI never
    shows text from one model then swaps it for another mid-stream (PRD §12).
    """
    candidates = [provider] + [p for p in permissive_providers() if p != provider]
    tried: list[str] = []
    last_err: Exception | None = None

    for candidate in candidates:
        adapter = get_adapter(candidate)
        gen = adapter.stream(system=system, prompt=prompt, json_mode=json_mode)
        try:
            first = next(gen)
        except StopIteration:
            first = None
        except (ProviderRefusal, ProviderError) as exc:
            tried.append(candidate)
            last_err = exc
            continue

        routed_from = provider if candidate != provider else None
        yield {
            "kind": "meta",
            "provider": candidate,
            "model": adapter.model,
            "routed_from": routed_from,
        }
        events = gen if first is None else itertools.chain([first], gen)
        for ev in events:
            if ev.response is not None:
                yield {"kind": "done", "response": ev.response}
            elif ev.delta:
                yield {"kind": "delta", "delta": ev.delta}
        return

    raise ProviderError(f"all providers failed for seat (tried {tried}): {last_err}")


def _critique_worker(
    report: SeatReport,
    provider: str,
    brief_text: str,
    others: list[dict],
    sink: queue.Queue,
) -> None:
    """Round 2 — stream one seat's real critique of the others (runs in a thread).

    Each seat reads the other members' recommendations and streams a concrete
    rebuttal. Emits ``critique_start`` / ``critique_delta`` (live tokens) then a
    terminal ``critique`` with the assembled text. Never raises: a failed seat
    yields an empty critique so the debate never hangs.
    """
    acc: list[str] = []
    role = _ROLE_BY_KEY.get(report.role)
    system = (role.system_prompt if role else "") + _CRITIQUE_FORMAT
    prompt = (
        f"{brief_text}\n\nYour own recommendations:\n"
        f"{json.dumps(report.recommendations)}\n\n"
        f"The OTHER council members' recommendations:\n{json.dumps(others)[:2500]}"
    )
    try:
        sink.put({"type": "critique_start", "role": report.role})
        for ev in _stream_with_failover(provider, system=system, prompt=prompt):
            if ev["kind"] == "delta":
                acc.append(ev["delta"])
                sink.put(
                    {"type": "critique_delta", "role": report.role, "delta": ev["delta"]}
                )
        sink.put({"type": "critique", "role": report.role, "text": "".join(acc).strip()})
    except Exception:  # noqa: BLE001 - a failed rebuttal degrades, never hangs
        sink.put({"type": "critique", "role": report.role, "text": ""})
    finally:
        sink.put({"type": "__critique_done__"})


def _parse_judge_json(text: str) -> dict | None:
    """Parse the Judge's JSON, tolerating code fences / surrounding prose.

    Real models in json_mode sometimes wrap the object in ```json ... ``` fences
    or add a stray sentence; a bare ``json.loads`` would discard the whole
    adjudication. This strips a fence, then falls back to extracting the first
    balanced ``{...}`` object.
    """
    if not text:
        return None
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        brace = raw.find("{")
        if brace != -1:
            raw = raw[brace:]
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except (json.JSONDecodeError, TypeError):
            return None
    return data if isinstance(data, dict) else None


def _run_judge(
    provider: str, brief_text: str, reports: list[SeatReport], conflicts: list[dict]
) -> tuple[str, list[dict]]:
    payload = {
        "reports": [
            {"source": r.role, "recommendations": r.recommendations} for r in reports
        ],
        "conflicts": conflicts,
    }

    summary = ""
    try:
        resp, _used, _routed = _call_with_failover(
            provider,
            system=JUDGE.system_prompt,
            prompt=f"{brief_text}\n\nCouncil output:\n{json.dumps(payload)}",
            json_mode=True,
        )
        data = _parse_judge_json(resp.text)
        if isinstance(data, dict):
            summary = str(data.get("summary") or "")
            decisions = data.get("decisions")
            if isinstance(decisions, list) and decisions:
                return summary, decisions
    except ProviderError:
        # Judge provider (and every failover) unavailable — degrade like the
        # seats/critiques do rather than aborting the whole pipeline mid-run.
        pass

    # Fallback: surface every recommendation as needs_evidence so nothing is
    # silently accepted, but preserve the model's real summary when we got one.
    fallback_decisions = [
        {
            "source": r.role,
            "point": r.recommendations[0],
            "label": "needs_evidence",
            "reason": "Judge output unavailable; held for citation.",
        }
        for r in reports
        if r.recommendations
    ]
    return (
        summary or "Strategy pending human review (Judge fallback).",
        fallback_decisions,
    )


def _seat_worker(role: Role, provider: str, brief_text: str, sink: queue.Queue) -> None:
    """Stream one Round-1 seat, pushing live events onto ``sink`` (runs in a thread).

    Emits ``report_start`` (chosen provider/model), a ``report_delta`` per token,
    then a terminal ``report`` with the assembled :class:`SeatReport`. Never
    raises: a failed seat becomes a ``seat_error`` event so one bad model can't
    hang or crash the whole council. Always posts ``__seat_done__`` so the
    consumer's countdown completes.
    """
    acc: list[str] = []
    provider_used = provider
    model = ""
    routed_from: str | None = None
    resp: AdapterResponse | None = None
    try:
        for ev in _stream_with_failover(
            provider, system=role.system_prompt + _REPORT_FORMAT, prompt=brief_text
        ):
            if ev["kind"] == "meta":
                provider_used, model, routed_from = (
                    ev["provider"], ev["model"], ev["routed_from"]
                )
                sink.put({
                    "type": "report_start",
                    "role": role.key,
                    "provider": provider_used,
                    "model": model,
                    "routed_from": routed_from,
                })
            elif ev["kind"] == "delta":
                acc.append(ev["delta"])
                sink.put({"type": "report_delta", "role": role.key, "delta": ev["delta"]})
            elif ev["kind"] == "done":
                resp = ev["response"]
        text = "".join(acc)
        # Parse the streamed reply into discrete recommendations + real confidence.
        recs, confidence = _parse_recommendations(text)
        report = SeatReport(
            role=role.key,
            provider=provider_used,
            model=resp.model if resp else model,
            recommendations=recs,
            confidence=confidence,
            tokens=resp.tokens if resp else max(1, len(text) // 4),
            routed_from=routed_from,
        )
        sink.put({"type": "report", "role": role.key, "report": report})
    except Exception as exc:  # noqa: BLE001 - surface, never hang the run
        sink.put({"type": "seat_error", "role": role.key, "error": str(exc)})
    finally:
        sink.put({"type": "__seat_done__"})


def run_council_events(brief: dict, seats: dict[str, str] | None = None):
    """Run the council, yielding progress events as each step completes.

    Round 1 runs all seats **concurrently** and streams their tokens live, so the
    four models "type" side by side instead of one after another — both faster
    and far more engaging (PRD §8.2, §16). Yields ``{"type": ...}`` dicts:

        {"type": "roster",       "seats": [...]}          # pre-render seat boxes
        {"type": "report_start", "role", "provider", ...} # a seat began (R1)
        {"type": "report_delta", "role", "delta"}         # a token, live (R1)
        {"type": "report",       "role", "report"}        # a seat finished (R1)
        {"type": "seat_error",   "role", "error"}         # a seat failed (R1)
        {"type": "critique_start","role"}                 # a seat began rebuttal (R2)
        {"type": "critique_delta","role", "delta"}        # a token, live (R2)
        {"type": "critique",     "role", "text"}          # a seat's rebuttal (R2)
        {"type": "conflict",     "data": dict}            # Round 2, per conflict
        {"type": "decision",     "decision": dict}        # Round 3, per ruling
        {"type": "done",         "result": CouncilResult} # terminal

    ``run_council`` is implemented on top of this generator so there is one code
    path for batch and streaming.
    """
    seats = {**DEFAULT_SEATS, **(seats or {})}
    brief_text = _brief_text(brief)

    # Roster first, so the UI can pre-render one box per seat before any token.
    yield {
        "type": "roster",
        "seats": [{"role": role.key, "provider": seats[role.key]} for role in ROLES],
    }

    # Round 1 — fan out every seat onto its own thread; drain a shared queue so
    # events surface in real arrival order (interleaved, live) as they happen.
    sink: queue.Queue = queue.Queue()
    reports: list[SeatReport] = []
    with ThreadPoolExecutor(max_workers=max(1, len(ROLES))) as pool:
        for role in ROLES:
            pool.submit(_seat_worker, role, seats[role.key], brief_text, sink)
        remaining = len(ROLES)
        while remaining > 0:
            item = sink.get()
            if item["type"] == "__seat_done__":
                remaining -= 1
                continue
            if item["type"] == "report":
                reports.append(item["report"])
            yield item

    # Deterministic order for debate/judge regardless of which seat finished first.
    order = {role.key: i for i, role in enumerate(ROLES)}
    reports.sort(key=lambda r: order.get(r.role, len(order)))

    # Round 2 — real debate. Every seat critiques the others concurrently and
    # streams its rebuttal live; conflicts are derived from what they actually
    # say, not a canned template (PRD §8.2).
    messages: list[dict] = []
    conflicts: list[dict] = []
    if len(reports) >= 2:
        d_sink: queue.Queue = queue.Queue()
        critiques: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=len(reports)) as pool:
            for r in reports:
                others = [
                    {"role": o.role, "recommendations": o.recommendations}
                    for o in reports
                    if o.role != r.role
                ]
                pool.submit(
                    _critique_worker, r, seats[r.role], brief_text, others, d_sink
                )
            remaining = len(reports)
            while remaining > 0:
                item = d_sink.get()
                if item["type"] == "__critique_done__":
                    remaining -= 1
                    continue
                if item["type"] == "critique":
                    critiques[item["role"]] = item["text"]
                yield item
        # Build real conflicts + debate transcript from the streamed rebuttals.
        for r in reports:
            text = (critiques.get(r.role) or "").strip()
            if not text:
                continue
            messages.append({"from": r.role, "tag": "rebuttal", "text": text})
            conflict = {"between": [r.role, "council"], "issue": _first_sentence(text)}
            conflicts.append(conflict)
            yield {"type": "conflict", "data": conflict}

    summary, decisions = _run_judge(  # Round 3 — judge (JSON, non-streamed)
        seats["judge"], brief_text, reports, conflicts
    )
    for decision in decisions:
        yield {"type": "decision", "decision": decision}

    yield {
        "type": "done",
        "result": CouncilResult(
            reports=reports,
            debate_messages=messages,
            conflicts=conflicts,
            decisions=decisions,
            strategy_summary=summary,
            total_tokens=sum(r.tokens for r in reports),
        ),
    }


def run_council(brief: dict, seats: dict[str, str] | None = None) -> CouncilResult:
    """Run the three-round council for a brief (batch — returns the result).

    ``seats`` maps role key → provider; defaults to ``DEFAULT_SEATS``. Works
    fully against the mock adapter, so it is callable without any provider keys.
    """
    result: CouncilResult | None = None
    for event in run_council_events(brief, seats):
        if event["type"] == "done":
            result = event["result"]
    assert result is not None  # the generator always yields a terminal "done"
    return result
