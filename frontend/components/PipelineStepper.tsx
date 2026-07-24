"use client";

import { useLang } from "../lib/i18n";

export type StageStatus = "pending" | "running" | "done";

// The user-facing pipeline: mirrors how a human team works. Backend emits four
// verification stages (factcheck/scoring/gate/compliance) that all collapse
// into the single "Final checks" step here (see STAGE_TO_STEP in lib/run.ts).
export const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: "keywords", label: "Keywords" },
  { key: "competitors", label: "Competitors" },
  { key: "council", label: "Debate" },
  { key: "outline", label: "Outline" },
  { key: "article", label: "Write" },
  { key: "polish", label: "Polish" },
  { key: "checks", label: "Final checks" },
];

export default function PipelineStepper({
  status,
}: {
  status: Record<string, StageStatus>;
}) {
  const { t } = useLang();
  return (
    <div className="stepper">
      {PIPELINE_STAGES.map((s, i) => {
        const st: StageStatus = status[s.key] ?? "pending";
        return (
          <div className={`step step-${st}`} key={s.key}>
            <div className="step-dot">
              {st === "done" ? "✓" : st === "running" ? <span className="spin" /> : i + 1}
            </div>
            <div className="step-label">{t(s.label)}</div>
            {i < PIPELINE_STAGES.length - 1 && <div className="step-line" />}
          </div>
        );
      })}
    </div>
  );
}
