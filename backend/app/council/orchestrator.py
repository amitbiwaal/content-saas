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
from app.council.roles import (
    DEFAULT_SEATS,
    JUDGE,
    JUDGE_DELIBERATION_PROMPT,
    ROLES,
    Role,
)

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

# Round-2 instruction: challenge ONE specific rival directly (pairwise debate).
_REBUT_FORMAT = (
    "\n\nDEBATE — rebuttal. You are challenging ONE specific rival, named below, "
    "not the group. In 2 to 4 sentences, name the single most important flaw, "
    "risk, or disagreement in THEIR position and defend your own. Address them "
    "directly by their role (e.g. \"The Trend Analyst is wrong that…\"). Be "
    "concrete. Do not restate your own list."
)

# Round-3 instruction: respond to the rebuttal aimed at you — hold, yield, or move.
_REPLY_FORMAT = (
    "\n\nDEBATE — response. A rival just challenged your position (quoted below). "
    "Reply in 2 to 4 sentences, addressing them directly. Begin your reply with "
    "exactly ONE word in caps — DEFEND (you hold your ground), CONCEDE (they are "
    "right; you drop or soften the point), or REVISE (you change your "
    "recommendation) — then a colon and your reasoning."
)

_CONF_RE = re.compile(r"confidence\s*[:=]\s*([01](?:\.\d+)?|\.\d+|\d{1,3})", re.IGNORECASE)
_LIST_RE = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
# Leading stance token a seat writes in its reply (parsed → badge, then stripped).
_STANCE_RE = re.compile(r"^\s*(DEFEND|CONCEDE|REVISE)\b[:.\-—\s]*", re.IGNORECASE)


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
    # Every debate utterance in order — the threaded, replayable transcript. Each
    # entry: {round, role, provider, addressed_to, stance, text}.
    turns: list[dict] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    strategy_summary: str = ""
    # The Judge's human-readable deliberation over the debate (streamed live).
    deliberation: str = ""
    total_tokens: int = 0


def _research_digest(research: dict) -> str:
    """Structured, seat-readable research summary (keywords, rivals, questions).

    Replaces a raw truncated JSON dump: the seats debate real data, so the data
    must be legible — the keyword set, each ranking competitor page with the
    headings it actually uses, the reader questions, and the citable sources.
    """
    if not research:
        return "Research: (none gathered)"
    lines: list[str] = []

    kw = research.get("keywords") or {}
    if kw:
        lines.append(f"PRIMARY KEYWORD: {kw.get('primary', '')}")
        if kw.get("secondary"):
            lines.append("Secondary keywords: " + "; ".join(kw["secondary"][:8]))
        if kw.get("longtail"):
            lines.append("Longtail questions: " + " | ".join(kw["longtail"][:6]))
    if research.get("intent"):
        lines.append(f"Search intent: {research['intent']}")

    competitors = research.get("competitors") or []
    if competitors:
        lines.append("\nRANKING COMPETITOR PAGES (fetched + analysed):")
        for i, page in enumerate(competitors[:6], start=1):
            if not isinstance(page, dict):
                continue
            heads = "; ".join((page.get("headings") or [])[:10]) or "(no headings found)"
            extras: list[str] = []
            if page.get("word_count"):
                extras.append(f"{page['word_count']} words")
            if page.get("has_table"):
                extras.append("has comparison table")
            if page.get("has_faq"):
                extras.append("has FAQ")
            suffix = f" [{', '.join(extras)}]" if extras else ""
            lines.append(
                f"{i}. {page.get('domain', '?')} — \"{page.get('title', '')}\"{suffix}\n"
                f"   Covers: {heads}"
            )
    elif research.get("headings"):
        lines.append(
            "Competitor headings: " + "; ".join(str(h) for h in research["headings"][:15])
        )

    paa = [str(q) for q in research.get("paa") or [] if str(q).strip()]
    if paa:
        lines.append("\nREAL READER QUESTIONS: " + " | ".join(paa[:8]))

    evidence = research.get("facts") or {}
    facts = evidence.get("facts") or []
    if facts:
        lines.append("\nVERIFIED FACTS mined from those pages (the article's raw material):")
        for f in facts[:10]:
            if isinstance(f, dict):
                lines.append(f"- {f.get('text', '')} [{f.get('source', '')}]")
    if evidence.get("consensus"):
        lines.append("Cross-source CONSENSUS: " + " | ".join(evidence["consensus"][:4]))
    if evidence.get("disagreements"):
        lines.append(
            "Cross-source DISAGREEMENTS (our chance to add original insight): "
            + " | ".join(evidence["disagreements"][:4])
        )

    sources = research.get("sources") or []
    if sources:
        doms = [s.get("domain") or s.get("title", "") for s in sources if isinstance(s, dict)]
        lines.append("Citable sources: " + ", ".join(d for d in doms if d)[:400])
    return "\n".join(lines)[:6500]


def _brief_text(brief: dict) -> str:
    text = (
        f"Topic: {brief.get('topic')}\n"
        f"Primary keyword: {brief.get('keyword')}\n"
        f"Country: {brief.get('country', 'US')}\n"
        f"Audience: {brief.get('audience') or 'general'}\n"
        f"Tone: {brief.get('tone') or 'neutral'}\n"
        f"Goal: {brief.get('goal') or 'rank and be cited'}\n\n"
        f"=== RESEARCH DATA (debate from THIS, not from generic knowledge) ===\n"
        f"{_research_digest(brief.get('research') or {})}"
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


def _title(role_key: str) -> str:
    """Human role title (e.g. 'Trend Analyst') for addressing a rival by name."""
    role = _ROLE_BY_KEY.get(role_key)
    return role.title if role else role_key.replace("_", " ").title()


def _split_stance(text: str) -> tuple[str, str]:
    """Parse a reply's leading DEFEND/CONCEDE/REVISE token → (stance, clean_text).

    The seat leads its reply with one caps word declaring whether it holds,
    yields, or moves; we lift it into a stance badge and strip it from the shown
    text. Falls back to a neutral ``reply`` stance if the seat didn't comply.
    """
    match = _STANCE_RE.match(text)
    if match:
        return match.group(1).lower(), text[match.end():].strip()
    return "reply", text.strip()


def _pairing(reports: list[SeatReport]) -> dict[str, str]:
    """Directed ring: each seat is paired to critique exactly one rival.

    ``reports[i]`` challenges ``reports[i+1]`` (wrapping), so with 4 seats every
    model both critiques one rival and is critiqued by one — a clean pairwise
    debate rather than everyone-vs-the-group.
    """
    n = len(reports)
    if n < 2:
        return {}
    return {reports[i].role: reports[(i + 1) % n].role for i in range(n)}


def _debate_worker(
    role_key: str,
    provider: str,
    system: str,
    prompt: str,
    round_no: int,
    addressed_to: str,
    stance_hint: str,
    parse_stance: bool,
    sink: queue.Queue,
) -> None:
    """Stream one debate turn (runs in a thread) — a rebuttal or a reply.

    Emits ``turn_start`` (so the UI opens a live bubble threaded at ``addressed_to``),
    a ``turn_delta`` per token, then a terminal ``turn`` with the assembled text and
    the final parsed stance. Never raises: a failed seat yields an empty turn so
    the debate never hangs. Always posts ``__turn_done__`` for the consumer's
    countdown.
    """
    acc: list[str] = []
    try:
        sink.put({
            "type": "turn_start",
            "round": round_no,
            "role": role_key,
            "provider": provider,
            "addressed_to": addressed_to,
            "stance": stance_hint,
        })
        for ev in _stream_with_failover(provider, system=system, prompt=prompt):
            if ev["kind"] == "delta":
                acc.append(ev["delta"])
                sink.put({
                    "type": "turn_delta",
                    "round": round_no,
                    "role": role_key,
                    "delta": ev["delta"],
                })
        text = "".join(acc).strip()
        stance, clean = (_split_stance(text) if parse_stance else (stance_hint, text))
        sink.put({
            "type": "turn",
            "round": round_no,
            "role": role_key,
            "provider": provider,
            "addressed_to": addressed_to,
            "stance": stance,
            "text": clean,
        })
    except Exception:  # noqa: BLE001 - a failed turn degrades, never hangs
        sink.put({
            "type": "turn",
            "round": round_no,
            "role": role_key,
            "provider": provider,
            "addressed_to": addressed_to,
            "stance": stance_hint,
            "text": "",
        })
    finally:
        sink.put({"type": "__turn_done__"})


def _run_debate_round(
    reports: list[SeatReport],
    brief_text: str,
    round_no: int,
    targets: dict[str, str],
    context: dict[str, str],
    is_rebuttal: bool,
):
    """Run one concurrent debate round; yield its live events, return the turns.

    Every seat speaks at once (its own thread) and tokens interleave live. Each
    seat addresses the single rival named in ``targets[role]``; ``context[role]``
    is the rival's material it must respond to (their recommendations for a
    rebuttal, their rebuttal text for a reply).
    """
    d_sink: queue.Queue = queue.Queue()
    collected: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(reports)) as pool:
        for r in reports:
            target = targets.get(r.role)
            if not target:
                continue
            role = _ROLE_BY_KEY.get(r.role)
            base = role.system_prompt if role else ""
            if is_rebuttal:
                system = base + _REBUT_FORMAT
                prompt = (
                    f"{brief_text}\n\nYour position:\n{json.dumps(r.recommendations)}\n\n"
                    f"You are debating the {_title(target)}. Their position:\n"
                    f"{context.get(r.role, '')[:2000]}"
                )
            else:
                system = base + _REPLY_FORMAT
                prompt = (
                    f"{brief_text}\n\nYour original position:\n"
                    f"{json.dumps(r.recommendations)}\n\n"
                    f"The {_title(target)} challenged you:\n"
                    f"\"{context.get(r.role, '')[:1500]}\"\n\nRespond to them directly."
                )
            pool.submit(
                _debate_worker, r.role, r.provider, system, prompt,
                round_no, target, ("rebut" if is_rebuttal else "reply"),
                not is_rebuttal, d_sink,
            )
        remaining = sum(1 for r in reports if targets.get(r.role))
        while remaining > 0:
            item = d_sink.get()
            if item["type"] == "__turn_done__":
                remaining -= 1
                continue
            if item["type"] == "turn":
                collected[item["role"]] = item
            yield item
    return collected


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


def _build_transcript(reports: list[SeatReport], turns: list[dict]) -> list[dict]:
    """Assemble the full debate transcript the Judge deliberates over.

    Openings (round-1 recommendations + confidence) followed by every debate turn
    in order — so the Judge rules on positions *as they stood after the debate*,
    not just the opening reports (the old Judge never saw the rebuttals at all).
    """
    transcript: list[dict] = [
        {
            "round": 1,
            "role": r.role,
            "stance": "open",
            "recommendations": r.recommendations,
            "confidence": r.confidence,
        }
        for r in reports
    ]
    transcript.extend(
        {
            "round": t["round"],
            "role": t["role"],
            "addressed_to": t.get("addressed_to"),
            "stance": t.get("stance"),
            "text": t.get("text", ""),
        }
        for t in turns
    )
    return transcript


def _judge_deliberate(provider: str, brief_text: str, transcript: list[dict]):
    """Round 3.5 — stream the Judge's plain-prose deliberation over the debate.

    Yields ``judge_start`` / ``judge_delta`` (live tokens) then a terminal
    ``judge`` event with the assembled deliberation. Never raises: on total
    provider failure it yields an empty deliberation and the run continues to the
    JSON verdict.
    """
    acc: list[str] = []
    prompt = f"{brief_text}\n\nDebate transcript:\n{json.dumps(transcript)[:6000]}"
    try:
        yield {"type": "judge_start"}
        for ev in _stream_with_failover(
            provider, system=JUDGE_DELIBERATION_PROMPT, prompt=prompt
        ):
            if ev["kind"] == "delta":
                acc.append(ev["delta"])
                yield {"type": "judge_delta", "delta": ev["delta"]}
    except Exception:  # noqa: BLE001 - deliberation is best-effort; verdict follows
        pass
    yield {"type": "judge", "text": "".join(acc).strip()}


def _run_judge(
    provider: str,
    brief_text: str,
    reports: list[SeatReport],
    transcript: list[dict],
    deliberation: str,
) -> tuple[str, list[dict]]:
    """Round 3 — the strict-JSON verdict, informed by the whole debate.

    Unlike the old Judge (which only saw the opening reports + a canned conflict
    list), this receives the full ``transcript`` and the Judge's own
    ``deliberation`` so its rulings reflect who actually won each exchange.
    """
    payload = {"transcript": transcript, "deliberation": deliberation}

    summary = ""
    try:
        resp, _used, _routed = _call_with_failover(
            provider,
            system=JUDGE.system_prompt,
            prompt=f"{brief_text}\n\nCouncil transcript + your deliberation:\n"
            f"{json.dumps(payload)[:7000]}",
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
        # seats/turns do rather than aborting the whole pipeline mid-run.
        pass

    # Fallback: surface every recommendation as needs_evidence so nothing is
    # silently accepted, but prefer the streamed deliberation as the summary.
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
        summary or deliberation or "Strategy pending human review (Judge fallback).",
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


def run_council_events(
    brief: dict, seats: dict[str, str] | None = None, rounds: int = 2
):
    """Run the council, yielding progress events as each step completes.

    Round 1 runs all seats **concurrently** and streams their tokens live, so the
    four models "type" side by side. Then a real **pairwise debate**: each seat is
    paired to challenge one specific rival (``rounds`` back-and-forth rounds — a
    rebuttal, then a reply where the challenged seat DEFENDs / CONCEDEs / REVISEs),
    every turn streamed live and threaded by who addresses whom. Finally the Judge
    *deliberates out loud* over the whole transcript (streamed) and returns a
    strict-JSON verdict informed by the debate (PRD §8.2, §16). Yields
    ``{"type": ...}`` dicts:

        {"type": "roster",       "seats": [...]}          # pre-render seat boxes
        {"type": "report_start", "role", "provider", ...} # a seat began (R1)
        {"type": "report_delta", "role", "delta"}         # a token, live (R1)
        {"type": "report",       "role", "report"}        # a seat finished (R1)
        {"type": "seat_error",   "role", "error"}         # a seat failed (R1)
        {"type": "turn_start",   "round","role","addressed_to","stance"} # debate turn opens
        {"type": "turn_delta",   "round","role","delta"}  # a token, live (debate)
        {"type": "turn",         "round","role","addressed_to","stance","text"} # turn done
        {"type": "conflict",     "data": dict}            # a real pairwise clash
        {"type": "judge_start"}                           # Judge began deliberating
        {"type": "judge_delta",  "delta"}                 # a token, live (Judge)
        {"type": "judge",        "text"}                  # Judge deliberation done
        {"type": "decision",     "decision": dict}        # a Judge ruling
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

    # Rounds 2..N — real pairwise debate. Each seat challenges ONE rival, that
    # rival replies (DEFEND/CONCEDE/REVISE), and so on. Every turn streams live
    # and is threaded by who addresses whom; conflicts are the actual clashes
    # surfaced in the rebuttal round, not a canned template (PRD §8.2).
    turns: list[dict] = []
    conflicts: list[dict] = []
    if len(reports) >= 2:
        pair = _pairing(reports)  # role → the rival it opens against (rebuttal)
        recs_by_role = {r.role: r.recommendations for r in reports}
        incoming_from: dict[str, str] = {}  # role → who last challenged it
        incoming_text: dict[str, str] = {}  # role → that challenge's text
        for dr in range(1, max(1, rounds) + 1):
            round_no = dr + 1  # reports are round 1; debate starts at round 2
            is_rebuttal = dr == 1
            if is_rebuttal:
                targets = pair
                context = {
                    role: json.dumps(recs_by_role.get(tgt, []))
                    for role, tgt in targets.items()
                }
            else:
                # Reply to whoever last challenged me (ring keeps this 1:1).
                targets = dict(incoming_from)
                context = dict(incoming_text)
            if not targets:
                break

            collected = yield from _run_debate_round(
                reports, brief_text, round_no, targets, context, is_rebuttal
            )

            next_from: dict[str, str] = {}
            next_text: dict[str, str] = {}
            for role, turn in collected.items():
                text = (turn.get("text") or "").strip()
                addressed = turn.get("addressed_to")
                turns.append({
                    "round": turn["round"],
                    "role": role,
                    "provider": turn.get("provider", ""),
                    "addressed_to": addressed,
                    "stance": turn.get("stance", "reply"),
                    "text": text,
                })
                if addressed and text:
                    next_from[addressed] = role
                    next_text[addressed] = text
                    if is_rebuttal:
                        conflict = {
                            "between": [role, addressed],
                            "issue": _first_sentence(text),
                        }
                        conflicts.append(conflict)
                        yield {"type": "conflict", "data": conflict}
            incoming_from, incoming_text = next_from, next_text

    # Back-compat blob for the legacy Debate table (the turn list is canonical).
    messages = [
        {
            "from": t["role"],
            "to": t.get("addressed_to"),
            "round": t["round"],
            "tag": t.get("stance"),
            "text": t["text"],
        }
        for t in turns
        if t.get("text")
    ]

    # Round 3 — Judge. Deliberate out loud over the whole transcript (streamed),
    # then rule in strict JSON informed by that deliberation.
    transcript = _build_transcript(reports, turns)
    deliberation = ""
    for jev in _judge_deliberate(seats["judge"], brief_text, transcript):
        if jev["type"] == "judge":
            deliberation = jev["text"]
        yield jev

    summary, decisions = _run_judge(
        seats["judge"], brief_text, reports, transcript, deliberation
    )
    for decision in decisions:
        yield {"type": "decision", "decision": decision}

    yield {
        "type": "done",
        "result": CouncilResult(
            reports=reports,
            debate_messages=messages,
            conflicts=conflicts,
            turns=turns,
            decisions=decisions,
            strategy_summary=summary,
            deliberation=deliberation,
            total_tokens=sum(r.tokens for r in reports),
        ),
    }


def run_council(
    brief: dict, seats: dict[str, str] | None = None, rounds: int = 2
) -> CouncilResult:
    """Run the council for a brief (batch — returns the result).

    ``seats`` maps role key → provider; defaults to ``DEFAULT_SEATS``. ``rounds``
    is the number of debate rounds after the opening reports (default 2: a
    rebuttal + a reply). Works fully against the mock adapter, so it is callable
    without any provider keys.
    """
    result: CouncilResult | None = None
    for event in run_council_events(brief, seats, rounds):
        if event["type"] == "done":
            result = event["result"]
    assert result is not None  # the generator always yields a terminal "done"
    return result
