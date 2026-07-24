"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Shell from "../../../components/Shell";
import { api } from "../../../lib/api";
import { useLang } from "../../../lib/i18n";

export default function NewProjectPage() {
  const { t } = useLang();
  const router = useRouter();
  const [form, setForm] = useState({
    website: "",
    topic: "",
    country: "US",
    audience: "",
    tone: "",
    goal: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Keyword stays blank on purpose: the pipeline's keyword-research stage
      // derives the primary keyword from the description.
      const project = await api.createProject({
        ...form,
        website: form.website.trim() || "unassigned",
        keyword: "",
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  const valid = form.topic.trim().length > 0;

  return (
    <Shell title={t("New Content Project")}>
      <form className="card form" onSubmit={submit}>
        <p className="muted">{t("Describe the article — the pipeline finds the keywords, studies competitors, debates the angle, then writes and polishes it.")}</p>
        <label>{t("Describe your article*")}
          <textarea
            value={form.topic}
            onChange={(e) => setForm({ ...form, topic: e.target.value })}
            placeholder={t("e.g. Best standing desks for a home office in 2026 — for remote workers on a budget, honest pros and cons")}
            rows={3}
            maxLength={500}
          />
        </label>
        <div className="form-row">
          <label>{t("Website")}<input value={form.website} onChange={set("website")} placeholder="yoursite.com" /></label>
          <label>{t("Country")}<input value={form.country} onChange={set("country")} placeholder="US" /></label>
        </div>
        <div className="form-row">
          <label>{t("Audience")}<input value={form.audience} onChange={set("audience")} placeholder={t("who is this for?")} /></label>
          <label>{t("Tone")}<input value={form.tone} onChange={set("tone")} placeholder={t("e.g. friendly")} /></label>
        </div>
        <label>{t("Goal")}<input value={form.goal} onChange={set("goal")} placeholder={t("rank on Google and appear in AI answers")} /></label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" disabled={!valid || busy} type="submit">
          {busy ? t("Creating…") : t("Create project")}
        </button>
      </form>
    </Shell>
  );
}
