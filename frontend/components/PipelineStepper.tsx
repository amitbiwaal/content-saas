"use client";

import { useLang } from "../lib/i18n";

export type StageStatus = "pending" | "running" | "done";

export const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: "research", label: "Research" },
  { key: "council", label: "AI experts" },
  { key: "outline", label: "Outline" },
  { key: "article", label: "Draft" },
  { key: "factcheck", label: "Fact-check" },
  { key: "scoring", label: "Scoring" },
  { key: "gate", label: "Publish check" },
  { key: "compliance", label: "Policy check" },
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
