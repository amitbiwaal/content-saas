"use client";

import { useLang } from "../lib/i18n";

// Plain-English title per gated stage (what you're approving).
export const GATE_TITLES: Record<string, string> = {
  research: "Keyword & competitor research",
  council: "The AI experts' debate & plan",
  outline: "Article outline",
  draft: "Polished article draft",
};

// A prominent bar that freezes the flow at a gate and asks for a decision.
// Shared by the chat "Approve each step" mode and the /review page — rendered
// INLINE inside RunView right after the stage that paused.
export default function GateBar({
  stage, busy, feedback, setFeedback, onApprove, onReject,
}: {
  stage: string;
  busy: boolean;
  feedback: string;
  setFeedback: (s: string) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useLang();
  return (
    <div className="gatebar fade-in">
      <div className="gatebar-head">
        <span className="gatebar-icon">⏸</span>
        <div>
          <div className="gatebar-title">
            {t("Awaiting your approval")} — {t(GATE_TITLES[stage] || stage)}
          </div>
          <div className="muted small">
            {t("Review it above. Approve to continue to the next step, or reject with feedback to redo this one.")}
          </div>
        </div>
      </div>
      <textarea
        className="rv-feedback"
        placeholder={t("Optional feedback to steer a redo (e.g. \"weigh pricing more\", \"tone down claims\")…")}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="gatebar-btns">
        <button className="btn btn-primary" disabled={busy} onClick={onApprove}>
          {busy ? t("…") : t("✓ Approve & continue")}
        </button>
        <button className="btn" disabled={busy} onClick={onReject}>
          {t("↻ Reject & regenerate")}
        </button>
      </div>
    </div>
  );
}
