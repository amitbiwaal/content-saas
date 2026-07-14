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
    keyword: "",
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
      const project = await api.createProject(form);
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  const valid = form.website && form.topic && form.keyword;

  return (
    <Shell title={t("New Content Project")}>
      <form className="card form" onSubmit={submit}>
        <p className="muted">{t("Capture the brief — Research Intelligence and the council kick off on the project page.")}</p>
        <label>{t("Website*")}<input value={form.website} onChange={set("website")} placeholder="spicyranked.com" /></label>
        <label>{t("Topic*")}<input value={form.topic} onChange={set("topic")} placeholder="FeetFinder Review 2026" /></label>
        <label>{t("Primary keyword*")}<input value={form.keyword} onChange={set("keyword")} placeholder="feetfinder reviews" /></label>
        <div className="form-row">
          <label>{t("Country")}<input value={form.country} onChange={set("country")} placeholder="US" /></label>
          <label>{t("Tone")}<input value={form.tone} onChange={set("tone")} placeholder="we-not-I" /></label>
        </div>
        <label>{t("Audience")}<input value={form.audience} onChange={set("audience")} placeholder={t("buyers evaluating the platform")} /></label>
        <label>{t("Goal")}<input value={form.goal} onChange={set("goal")} placeholder={t("rank on Google and appear in AI answers")} /></label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" disabled={!valid || busy} type="submit">
          {busy ? t("Creating…") : t("Create project")}
        </button>
      </form>
    </Shell>
  );
}
