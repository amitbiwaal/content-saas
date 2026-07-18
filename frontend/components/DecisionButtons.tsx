"use client";

import { useLang } from "../lib/i18n";

// Judge-decision labels the human can set. The two `primary` ones (Accept /
// Reject) are the headline human-in-the-loop actions and always show their label;
// the rest are the Judge's nuanced states, kept as compact icon toggles so no
// state is lost when moving off the old dropdown.
type LabelDef = { value: string; icon: string; label: string; cls: string; primary?: boolean };

export const DECISION_LABELS: LabelDef[] = [
  { value: "accepted", icon: "✓", label: "Accept", cls: "lab-green", primary: true },
  { value: "rejected", icon: "✕", label: "Reject", cls: "lab-red", primary: true },
  { value: "needs_evidence", icon: "⚑", label: "Needs evidence", cls: "lab-amber" },
  { value: "merge", icon: "⇄", label: "Merge", cls: "lab-blue" },
  { value: "manual_review", icon: "⊙", label: "Manual review", cls: "lab-purple" },
];

// Map a decision label → its colour class (kept for pills/badges elsewhere).
export const LABEL_CLASS: Record<string, string> = Object.fromEntries(
  DECISION_LABELS.map((l) => [l.value, l.cls]),
);

export default function DecisionButtons({
  value,
  disabled = false,
  onSelect,
}: {
  value: string;
  disabled?: boolean;
  onSelect?: (label: string) => void;
}) {
  const { t } = useLang();
  const locked = disabled || !onSelect;
  return (
    <div className="lab-btns" role="group" aria-label={t("Override the Judge decision")}>
      {DECISION_LABELS.map((l) => {
        const active = l.value === value;
        // Extra (non-primary) chips show icon only until they're the active choice.
        const showText = l.primary || active;
        return (
          <button
            key={l.value}
            type="button"
            className={`lab-btn ${l.cls} ${l.primary ? "primary" : "extra"} ${active ? "active" : ""}`}
            aria-pressed={active}
            disabled={locked}
            title={t(l.value.replace(/_/g, " "))}
            onClick={() => { if (!active) onSelect?.(l.value); }}
          >
            <span className="lab-btn-ic">{l.icon}</span>
            {showText && <span className="lab-btn-tx">{t(l.label)}</span>}
          </button>
        );
      })}
    </div>
  );
}
