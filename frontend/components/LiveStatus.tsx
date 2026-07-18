"use client";

import { useLang } from "../lib/i18n";
import { PIPELINE_STAGES } from "./PipelineStepper";
import type { RunState } from "../lib/run";

// Header status chip: an animated "equalizer" that names the live stage while the
// pipeline runs, and switches to a calm "needs your approval" cue when paused at
// a gate. Renders nothing when idle. Used by chat + the review page.
export default function LiveStatus({ run, busy }: { run: RunState | null; busy: boolean }) {
  const { t } = useLang();
  const paused = !!run?.awaiting;
  if (!busy && !paused) return null;
  const running = run ? PIPELINE_STAGES.find((s) => run.stages[s.key] === "running") : undefined;
  const label = paused ? t("Needs your approval") : running ? t(running.label) : t("Working");
  return (
    <span className={`livechip ${paused ? "livechip-paused" : ""}`} title={label}>
      {paused ? (
        <span className="livechip-pause" aria-hidden="true">⏸</span>
      ) : (
        <span className="livechip-bars" aria-hidden="true"><i /><i /><i /><i /></span>
      )}
      <span className="livechip-txt">{label}{!paused && <span className="livechip-dots">…</span>}</span>
    </span>
  );
}
