"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import RichArticleEditor from "../../../../components/RichArticleEditor";
import Shell from "../../../../components/Shell";
import { api } from "../../../../lib/api";
import type { Claim, DraftSection, Integrations, Project, ScoreResult, Scores } from "../../../../lib/types";

const READ_WPM = 220;

const TARGETS: Record<keyof Scores, number> = {
  seo: 85, aeo: 85, geo: 80, heo: 85, eeat: 80, fact: 80, spam: 25, originality: 70, publish: 85,
};
// Match the run/project/journey views: spam is "lower is better", every other
// axis passes at >= its target. (Fact previously used a stricter > here, giving
// contradictory READY/BLOCKED signals for a draft scoring exactly the target.)
const scoreOk = (axis: keyof Scores, v: number) =>
  axis === "spam" ? v < TARGETS[axis] : v >= TARGETS[axis];

const wordCount = (sections: DraftSection[]) =>
  sections.reduce((n, s) => n + (s.markdown || "").trim().split(/\s+/).filter(Boolean).length, 0);

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();

  const [sections, setSections] = useState<DraftSection[] | null>(null);
  const [seed, setSeed] = useState(0); // bump to re-seed the rich editor after external edits
  const [project, setProject] = useState<Project | null>(null);
  const [integ, setInteg] = useState<Integrations | null>(null);
  const [score, setScore] = useState<ScoreResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [scoring, setScoring] = useState(false);
  const [regenIdx, setRegenIdx] = useState<number | null>(null);
  const [proofing, setProofing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [claims, setClaims] = useState<Claim[]>([]);

  // Featured image
  const [hasImage, setHasImage] = useState(false);
  const [imgV, setImgV] = useState(0);
  const [imgAlt, setImgAlt] = useState("");
  const [imgGenerated, setImgGenerated] = useState(false);
  const [imgStyle, setImgStyle] = useState("");
  const [imgBusy, setImgBusy] = useState(false);

  // WordPress publish
  const [seoTitle, setSeoTitle] = useState("");
  const [focusKw, setFocusKw] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [wpStatus, setWpStatus] = useState<"draft" | "publish" | "future">("draft");
  const [schedule, setSchedule] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Custom-site (webhook) publish — for non-WordPress stacks
  const [whStatus, setWhStatus] = useState<"draft" | "publish">("draft");
  const [whPublishing, setWhPublishing] = useState(false);
  const [whMsg, setWhMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Distribute (LinkedIn / Reddit / Google Docs)
  const [distCh, setDistCh] = useState<"linkedin" | "reddit" | "gdoc">("linkedin");
  const [liText, setLiText] = useState<string | null>(null);
  const [rdTitle, setRdTitle] = useState<string | null>(null);
  const [rdBody, setRdBody] = useState("");
  const [rdSub, setRdSub] = useState("");
  const [distBusy, setDistBusy] = useState(false);
  const [distMsg, setDistMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rescore = useCallback(async (secs: DraftSection[]) => {
    setScoring(true);
    try { setScore(await api.previewScores(id, secs)); }
    catch { /* keep last */ }
    finally { setScoring(false); }
  }, [id]);

  useEffect(() => {
    api.getDraft(id).then((d) => { const s = d.sections || []; setSections(s); rescore(s); }).catch(() => setSections([]));
    api.getProject(id).then((p) => {
      setProject(p);
      setSeoTitle(p.topic || "");
      setFocusKw(p.keyword || "");
      const fi = (p.council_config as { featured_image?: { alt?: string; generated?: boolean } } | null)?.featured_image;
      if (fi) { setHasImage(true); setImgAlt(fi.alt || ""); setImgGenerated(!!fi.generated); setImgV(Date.now()); }
    }).catch(() => {});
    api.getIntegrations().then(setInteg).catch(() => {});
    api.getClaims(id).then(setClaims).catch(() => {});
  }, [id, rescore]);

  // Autosave a short beat after the last edit (manual Save still works).
  useEffect(() => {
    if (!dirty || !sections) return;
    const t = setTimeout(() => { void save(); }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, sections]);

  // Ctrl/Cmd+S saves immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  // The rich editor is uncontrolled; it reports the whole article back on edit.
  function onEditorChange(next: DraftSection[]) {
    setSections(next);
    setDirty(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => rescore(next), 600);
  }

  async function save() {
    if (!sections) return;
    setSaving(true); setError(null);
    try { await api.updateDraft(id, sections); setDirty(false); setSavedAt(Date.now()); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  async function proofread() {
    setProofing(true); setError(null);
    try {
      const d = await api.proofread(id);
      const s = d.sections || [];
      setSections(s); setSeed((v) => v + 1); setDirty(false); setSavedAt(Date.now()); rescore(s);
    } catch (e) { setError(String(e)); }
    finally { setProofing(false); }
  }

  async function regenerate(i: number) {
    if (i < 0) return;
    setRegenIdx(i); setError(null);
    try {
      const diff = await api.regenerateSection(id, i);
      setSections((prev) => {
        if (!prev) return prev;
        const next = prev.map((s, j) => (j === i ? { ...s, markdown: diff.new.markdown } : s));
        rescore(next); return next;
      });
      setSeed((v) => v + 1); // re-seed editor with regenerated section
      setDirty(false);
    } catch (e) { setError(String(e)); }
    finally { setRegenIdx(null); }
  }

  async function genImage() {
    setImgBusy(true); setError(null);
    try {
      const r = await api.generateImage(id, { style: imgStyle || undefined, alt: imgAlt || undefined });
      setHasImage(true); setImgAlt(r.alt); setImgGenerated(r.generated); setImgV(Date.now());
    } catch (e) { setError(String(e)); }
    finally { setImgBusy(false); }
  }

  async function publish() {
    setPublishing(true); setPublishMsg(null);
    try {
      const body: Record<string, unknown> = {
        seo: { title: seoTitle, focus_keyword: focusKw, meta_description: metaDesc },
        status: wpStatus,
      };
      if (wpStatus === "future" && schedule) body.schedule = new Date(schedule).toISOString();
      const res = await api.publishWordpress(id, body) as Record<string, string>;
      const st = res.status;
      const text =
        st === "published" ? `Published ✓ ${res.link || ""}` :
        st === "scheduled" ? `Scheduled ✓ ${res.link || ""}` :
        st === "would_publish" ? "Dry run ✓ — content prepared (set WORDPRESS_* in .env to publish live)." :
        st === "error" ? `WordPress error: ${res.error || "unknown"}` : JSON.stringify(res);
      setPublishMsg({ ok: st !== "error", text });
    } catch (e) {
      setPublishMsg({ ok: false, text: gateMessage(String(e)) });
    } finally { setPublishing(false); }
  }

  async function publishWh() {
    setWhPublishing(true); setWhMsg(null);
    try {
      const res = await api.publishWebhook(id, { status: whStatus }) as Record<string, string>;
      const st = res.status;
      const text =
        st === "published" ? `Published ✓ ${res.link || ""}` :
        st === "would_publish" ? "Dry run ✓ — connect your endpoint in Settings to publish live." :
        st === "error" ? `Endpoint error: ${res.error || "unknown"}` : JSON.stringify(res);
      setWhMsg({ ok: st !== "error", text });
    } catch (e) {
      setWhMsg({ ok: false, text: gateMessage(String(e)) });
    } finally { setWhPublishing(false); }
  }

  async function genPost(channel: "linkedin" | "reddit") {
    setDistBusy(true); setDistMsg(null);
    try {
      const r = await api.repurpose(id, channel);
      if (channel === "linkedin") setLiText(r.content.text || "");
      else { setRdTitle(r.content.title || ""); setRdBody(r.content.body || ""); }
    } catch (e) { setDistMsg({ ok: false, text: String(e) }); }
    finally { setDistBusy(false); }
  }

  async function pub(channel: "linkedin" | "reddit") {
    setDistBusy(true); setDistMsg(null);
    try {
      const bodyReq = channel === "linkedin"
        ? { text: liText || "" }
        : { title: rdTitle || "", body: rdBody, subreddit: rdSub || undefined };
      setDistMsg(distResult(await api.distribute(id, channel, bodyReq)));
    } catch (e) { setDistMsg({ ok: false, text: String(e) }); }
    finally { setDistBusy(false); }
  }

  async function gdoc() {
    setDistBusy(true); setDistMsg(null);
    try { setDistMsg(distResult(await api.exportGoogleDoc(id))); }
    catch (e) { setDistMsg({ ok: false, text: String(e) }); }
    finally { setDistBusy(false); }
  }

  if (sections === null) return <Shell title="Editor"><p className="muted">Loading…</p></Shell>;
  if (sections.length === 0)
    return (
      <Shell title="Editor">
        <p className="muted">No draft yet — <Link href={`/projects/${id}`}>run the pipeline</Link> first.</p>
      </Shell>
    );

  const gatePassed = score?.gate.passed ?? false;
  const words = wordCount(sections);
  const readMin = Math.max(1, Math.round(words / READ_WPM));

  // Real-time on-page SEO checklist (Yoast/RankMath style), computed client-side.
  const body = sections.map((s) => s.markdown).join("\n");
  const firstPara = (sections.find((s) => (s.markdown || "").trim())?.markdown || "").toLowerCase();
  const kw = focusKw.trim().toLowerCase();
  const hay = `${seoTitle} ${body}`.toLowerCase();
  const kwCount = kw ? (hay.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length : 0;
  const density = words ? (kwCount / words) * 100 : 0;
  const linkCount = (body.match(/\]\(/g) || []).length + (body.match(/https?:\/\//g) || []).length;
  const seoChecks: { label: string; ok: boolean; note: string }[] = [
    { label: "Title length", ok: seoTitle.length >= 30 && seoTitle.length <= 60, note: `${seoTitle.length} chars · 30–60` },
    { label: "Meta description", ok: metaDesc.length >= 120 && metaDesc.length <= 160, note: `${metaDesc.length} chars · 120–160` },
    { label: "Keyword in title", ok: !!kw && seoTitle.toLowerCase().includes(kw), note: kw ? (seoTitle.toLowerCase().includes(kw) ? "present" : "missing") : "set a keyword" },
    { label: "Keyword in intro", ok: !!kw && firstPara.includes(kw), note: kw ? (firstPara.includes(kw) ? "present" : "missing") : "—" },
    { label: "Keyword density", ok: density >= 0.3 && density <= 3, note: `${density.toFixed(1)}%` },
    { label: "Headings", ok: sections.length >= 3, note: `${sections.length}` },
    { label: "Links", ok: linkCount >= 2, note: `${linkCount}` },
    { label: "Featured image", ok: hasImage && !!imgAlt.trim(), note: hasImage ? (imgAlt.trim() ? "with alt" : "add alt") : "none" },
    { label: "Word count", ok: words >= 600, note: `${words}` },
  ];
  const seoPass = seoChecks.filter((c) => c.ok).length;

  return (
    <Shell
      title="Article Editor"
      status={
        <div className="actions" style={{ margin: 0, gap: 8 }}>
          <span className="muted">{words} words · {readMin} min read</span>
          <button className={`btn btn-sm ${focusMode ? "btn-primary" : ""}`} onClick={() => setFocusMode((f) => !f)} title="Focus mode">⛶</button>
          <select
            className="ed-regen-select"
            value=""
            disabled={regenIdx !== null}
            onChange={(e) => { const i = Number(e.target.value); e.target.value = ""; if (!Number.isNaN(i)) regenerate(i); }}
          >
            <option value="">{regenIdx !== null ? "Regenerating…" : "↻ Regenerate section…"}</option>
            {sections.map((s, i) => <option key={i} value={i}>{s.heading || `Section ${i + 1}`}</option>)}
          </select>
          <button className="btn btn-sm" onClick={proofread} disabled={proofing}>
            {proofing ? "Proofreading…" : "✨ Proofread"}
          </button>
          <Link className="btn btn-sm" href={`/projects/${id}`}>← Project</Link>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : dirty ? "Save" : savedAt ? "Saved ✓" : "Saved"}
          </button>
        </div>
      }
    >
      {error && <p className="error">{error}</p>}
      <div className={`editor editor-doc ${focusMode ? "editor-focus" : ""}`}>
        {/* One continuous, formatted, editable document */}
        <div className="ed-main">
          {hasImage && <img className="ed-hero" src={`${api.imageUrl(id)}?t=${imgV}`} alt={imgAlt} />}
          <h1 className="ed-doc-title">{seoTitle || project?.topic}</h1>
          <RichArticleEditor initial={sections} seedKey={seed} onChange={onEditorChange} />
        </div>

        {/* Right rail: image, scores, publish, export */}
        <aside className="ed-rail">
          {/* Featured image */}
          <div className="ed-card">
            <div className="ed-card-title">Featured image <span className="muted">16:9</span></div>
            {hasImage ? (
              <>
                <img className="ed-featured" src={`${api.imageUrl(id)}?t=${imgV}`} alt={imgAlt} />
                {!imgGenerated && <p className="muted xs">Placeholder — add OPENAI_API_KEY for a real image.</p>}
                <input className="ed-input" placeholder="Alt text" value={imgAlt} onChange={(e) => setImgAlt(e.target.value)} />
              </>
            ) : (
              <p className="muted xs">No image yet. Generate a 16:9 hero from the article.</p>
            )}
            <input className="ed-input" placeholder="Style hint (e.g. flat vector, photo)" value={imgStyle} onChange={(e) => setImgStyle(e.target.value)} />
            <button className="btn btn-primary btn-block" onClick={genImage} disabled={imgBusy}>
              {imgBusy ? "Generating…" : hasImage ? "↻ Regenerate image" : "🖼 Generate image"}
            </button>
          </div>

          {/* Live scores */}
          <div className="ed-card">
            <div className="ed-card-title">
              Live scores {scoring && <span className="spin spin-dark" />}
              {score && <span className={`pill ${gatePassed ? "ok" : "warn"}`} style={{ marginLeft: "auto" }}>{gatePassed ? "READY" : "BLOCKED"}</span>}
            </div>
            {score && (
              <>
                <div className="ed-score-list">
                  {(Object.keys(TARGETS) as (keyof Scores)[]).map((axis) => {
                    const v = score.scores[axis]; const ok = scoreOk(axis, v);
                    return (
                      <div className="ed-score-row" key={axis}>
                        <span className="ed-score-axis" title={axis.toUpperCase()}>{axis.toUpperCase()}</span>
                        <div className="ed-score-bar">
                          <span className={ok ? "good" : "bad"} style={{ width: `${Math.min(v, 100)}%` }} />
                          <span className="ed-score-tick" style={{ left: `${Math.min(TARGETS[axis], 100)}%` }} />
                        </div>
                        <span className={`ed-score-num ${ok ? "g" : "b"}`}>{v}</span>
                      </div>
                    );
                  })}
                </div>
                {!gatePassed && score.gate.reasons.length > 0 && (
                  <ul className="reasons small">{score.gate.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}</ul>
                )}
                {score.top_fixes.length > 0 && (
                  <div className="ed-fixes"><div className="ed-fixes-title">Top fix</div><p>{score.top_fixes[0].fix}</p></div>
                )}
              </>
            )}
          </div>

          {/* SEO analysis */}
          <div className="ed-card">
            <div className="ed-card-title">
              SEO analysis
              <span className={`pill ${seoPass >= 7 ? "ok" : "warn"}`} style={{ marginLeft: "auto" }}>{seoPass}/{seoChecks.length}</span>
            </div>
            <ul className="ed-seo-list">
              {seoChecks.map((c) => (
                <li key={c.label} className="ed-seo-row">
                  <span className={`ed-seo-dot ${c.ok ? "g" : "b"}`} aria-hidden="true" />
                  <span className="ed-seo-label">{c.label}</span>
                  <span className={`ed-seo-note ${c.ok ? "g" : "b"}`}>{c.note}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Fact-check */}
          {claims.length > 0 && (
            <div className="ed-card">
              <div className="ed-card-title">Fact-check <span className="muted">{claims.length}</span></div>
              <ul className="ed-claims">
                {claims.slice(0, 8).map((c, i) => (
                  <li key={c.id || i} className="ed-claim">
                    <span className={`lab risk-${c.risk}`}>{c.risk}</span>
                    <div className="ed-claim-body">
                      <div className="ed-claim-text">{c.text.length > 120 ? c.text.slice(0, 120) + "…" : c.text}</div>
                      <div className="ed-claim-src muted xs">{c.source ? (/^https?:\/\//.test(c.source) ? <a href={c.source} target="_blank" rel="noreferrer">source</a> : c.source) : "no source"}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* WordPress publish */}
          <div className="ed-card">
            <div className="ed-card-title">
              Publish to WordPress
              <span className={`wp-dot ${integ?.wordpress.configured ? "on" : ""}`} style={{ marginLeft: "auto" }} />
            </div>
            <p className="muted xs">
              {integ?.wordpress.configured ? `Connected: ${integ.wordpress.site_url || "site"}` : "Not connected — publish runs as a dry run."}
            </p>
            <input className="ed-input" placeholder="SEO title" value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} />
            <input className="ed-input" placeholder="Focus keyword" value={focusKw} onChange={(e) => setFocusKw(e.target.value)} />
            <textarea className="ed-input" placeholder="Meta description (≤160 chars)" rows={2} maxLength={180} value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} />
            <div className="ed-row">
              <select className="ed-input" value={wpStatus} onChange={(e) => setWpStatus(e.target.value as typeof wpStatus)}>
                <option value="draft">Draft</option>
                <option value="publish">Publish now</option>
                <option value="future">Schedule</option>
              </select>
              {wpStatus === "future" && (
                <input className="ed-input" type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
              )}
            </div>
            <button className="btn btn-primary btn-block" onClick={publish} disabled={publishing}>
              {publishing ? "Publishing…" : "⬆ Publish"}
            </button>
            {!gatePassed && <p className="muted xs">Note: live publish is blocked until the gate passes (scores above).</p>}
            {publishMsg && <p className={publishMsg.ok ? "ok-text xs" : "error xs"}>{publishMsg.text}</p>}
          </div>

          {/* Custom site (webhook) publish — non-WordPress stacks */}
          <div className="ed-card">
            <div className="ed-card-title">Publish to your site</div>
            <p className="muted xs">
              For non-WordPress sites (Ghost, Webflow, headless, or your own API). Connect an endpoint in Settings; otherwise this runs as a dry run.
            </p>
            <div className="ed-row">
              <select className="ed-input" value={whStatus} onChange={(e) => setWhStatus(e.target.value as typeof whStatus)}>
                <option value="draft">Draft</option>
                <option value="publish">Publish</option>
              </select>
            </div>
            <button className="btn btn-primary btn-block" onClick={publishWh} disabled={whPublishing}>
              {whPublishing ? "Publishing…" : "⬆ Publish to my site"}
            </button>
            {!gatePassed && <p className="muted xs">Live publish is blocked until the gate passes.</p>}
            {whMsg && <p className={whMsg.ok ? "ok-text xs" : "error xs"}>{whMsg.text}</p>}
          </div>

          {/* Distribute (repurpose + social) */}
          <div className="ed-card">
            <div className="ed-card-title">Distribute</div>
            <div className="dist-tabs">
              {(["linkedin", "reddit", "gdoc"] as const).map((c) => (
                <button key={c} className={`dist-tab ${distCh === c ? "on" : ""}`} onClick={() => setDistCh(c)}>
                  {c === "linkedin" ? "LinkedIn" : c === "reddit" ? "Reddit" : "Google Docs"}
                </button>
              ))}
            </div>

            {distCh === "linkedin" && (
              <>
                <button className="btn btn-sm btn-block" onClick={() => genPost("linkedin")} disabled={distBusy}>
                  {distBusy ? "Working…" : liText === null ? "✨ Generate LinkedIn post" : "↻ Regenerate"}
                </button>
                {liText !== null && (
                  <>
                    <textarea className="ed-input" rows={7} value={liText} onChange={(e) => setLiText(e.target.value)} />
                    <div className="muted xs">{liText.length} chars</div>
                    <button className="btn btn-primary btn-block" onClick={() => pub("linkedin")} disabled={distBusy}>⬆ Publish to LinkedIn</button>
                  </>
                )}
              </>
            )}

            {distCh === "reddit" && (
              <>
                <input className="ed-input" placeholder="Subreddit (e.g. productivity)" value={rdSub} onChange={(e) => setRdSub(e.target.value)} />
                <button className="btn btn-sm btn-block" onClick={() => genPost("reddit")} disabled={distBusy}>
                  {distBusy ? "Working…" : rdTitle === null ? "✨ Generate Reddit post" : "↻ Regenerate"}
                </button>
                {rdTitle !== null && (
                  <>
                    <input className="ed-input" placeholder="Title" value={rdTitle} onChange={(e) => setRdTitle(e.target.value)} />
                    <textarea className="ed-input" rows={6} value={rdBody} onChange={(e) => setRdBody(e.target.value)} />
                    <button className="btn btn-primary btn-block" onClick={() => pub("reddit")} disabled={distBusy}>⬆ Submit to Reddit</button>
                  </>
                )}
              </>
            )}

            {distCh === "gdoc" && (
              <>
                <p className="muted xs">Export the full article to a Google Doc for review.</p>
                <button className="btn btn-primary btn-block" onClick={gdoc} disabled={distBusy}>
                  {distBusy ? "Exporting…" : "📄 Export to Google Doc"}
                </button>
              </>
            )}

            {distMsg && <p className={distMsg.ok ? "ok-text xs" : "error xs"}>{distMsg.text}</p>}
          </div>

          {/* Export */}
          <div className="ed-card">
            <div className="ed-card-title">Export</div>
            <div className="ed-exports">
              <a className="chip" href={api.exportUrl(id, "markdown")} target="_blank" rel="noreferrer">MD</a>
              <a className="chip" href={api.exportUrl(id, "html")} target="_blank" rel="noreferrer">HTML</a>
              <a className="chip" href={api.exportUrl(id, "docx")} target="_blank" rel="noreferrer">DOCX</a>
              <a className="chip" href={api.exportUrl(id, "gutenberg")} target="_blank" rel="noreferrer">Gutenberg</a>
              <a className="chip" href={api.exportUrl(id, "jsonld")} target="_blank" rel="noreferrer">JSON-LD</a>
            </div>
          </div>
        </aside>
      </div>
    </Shell>
  );
}

// Map a distribute/export response into a readable status line.
function distResult(res: Record<string, string>): { ok: boolean; text: string } {
  const st = res.status;
  if (st === "published") return { ok: true, text: `Published ✓ ${res.link || res.id || ""}` };
  if (st === "would_publish" || st === "would_create")
    return { ok: true, text: "Dry run ✓ — content ready (connect the channel in .env for live posting)." };
  if (st === "error") return { ok: false, text: `Error: ${res.error || "unknown"}` };
  return { ok: true, text: JSON.stringify(res).slice(0, 160) };
}

// The publish endpoint returns 409 with the gate reasons as JSON in the error
// text; surface a readable line instead of the raw "409: {...}".
function gateMessage(err: string): string {
  const m = err.match(/\{.*\}/);
  if (m) {
    try {
      const d = JSON.parse(m[0]) as { reasons?: string[] };
      if (d.reasons?.length) return `Blocked by publish gate: ${d.reasons.join("; ")}`;
    } catch { /* fall through */ }
  }
  return err;
}
