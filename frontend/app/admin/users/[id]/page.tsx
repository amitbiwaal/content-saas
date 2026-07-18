"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Shell from "../../../../components/Shell";
import { api } from "../../../../lib/api";
import { useLang } from "../../../../lib/i18n";
import { PLANS } from "../../../../lib/pricing";
import type { AdminUserDetail } from "../../../../lib/types";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

const fmtDate = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export default function AdminUserDetailPage() {
  const { t } = useLang();
  const router = useRouter();
  const params = useParams();
  const id = String(params.id);

  const [meId, setMeId] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const d = await api.admin.getUser(id);
    setData(d);
  }, [id]);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.auth.me();
        setMeId(me.id);
        if (!me.is_admin) {
          setDenied(true);
          return;
        }
        await load();
      } catch (e) {
        setErr(msg(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  const u = data?.user;
  const isSelf = u?.id === meId;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyCredits() {
    const d = parseInt(delta, 10);
    if (!Number.isFinite(d) || d === 0) return;
    await run(async () => {
      await api.admin.setCredits(id, d, reason.trim() || undefined);
      setDelta("");
      setReason("");
    });
  }

  async function del() {
    setBusy(true);
    setErr(null);
    try {
      await api.admin.deleteUser(id);
      router.push("/admin");
    } catch (e) {
      setErr(msg(e));
      setBusy(false);
    }
  }

  if (denied) {
    return (
      <Shell title="Admin">
        <section className="panel admin-denied">
          <h2>{t("Admins only")}</h2>
          <Link className="btn" href="/dashboard">{t("Back to dashboard")}</Link>
        </section>
      </Shell>
    );
  }

  return (
    <Shell title="Admin · User" status={<Link className="btn btn-sm btn-ghost" href="/admin">← {t("All users")}</Link>}>
      {err && <p className="error">{err}</p>}

      {loading || !u ? (
        <p className="muted">{t("Loading…")}</p>
      ) : (
        <>
          {/* Account header */}
          <section className="panel admin-detail-head">
            <span className="admin-avatar admin-avatar-lg">{(u.name || u.email).charAt(0).toUpperCase()}</span>
            <div className="admin-detail-id">
              <div className="admin-detail-name">
                {u.name || u.email.split("@")[0]}
                {isSelf && <span className="admin-you">{t("you")}</span>}
              </div>
              <div className="admin-detail-email">{u.email}</div>
              <div className="admin-detail-badges">
                {!u.is_active && <span className="tag tag-red">{t("Suspended")}</span>}
                {u.effective_admin ? <span className="tag tag-green">{t("Admin")}</span> : <span className="tag">{t("Member")}</span>}
                {u.effective_admin && !u.is_admin && <span className="tag tag-blue">{t("via allow-list")}</span>}
                <span className="tag admin-plan-badge">{u.plan}</span>
                <span className="tag">{t("Joined")} {fmtDate(u.created_at)}</span>
              </div>
            </div>
            <div className="admin-detail-credits">
              <div className="metric-value">{u.credits.toLocaleString("en-US")}</div>
              <div className="metric-label">{t("credits")}</div>
            </div>
          </section>

          {/* Actions */}
          <section className="panel">
            <div className="panel-head"><h2>{t("Manage")}</h2></div>
            <div className="admin-manage">
              <div className="admin-manage-block">
                <label className="admin-manage-label">{t("Adjust credits")}</label>
                <div className="admin-credit-edit">
                  <input className="admin-credit-input" type="number" value={delta} placeholder="±"
                    onChange={(e) => setDelta(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") applyCredits(); }} />
                  <input className="admin-reason-input" type="text" value={reason} placeholder={t("reason (optional)")}
                    onChange={(e) => setReason(e.target.value)} />
                  <button className="btn btn-sm" disabled={busy} onClick={applyCredits}>{t("Apply")}</button>
                </div>
              </div>

              <div className="admin-manage-block">
                <label className="admin-manage-label">{t("Plan")}</label>
                <div className="admin-actions">
                  {PLANS.map((pl) => (
                    <button
                      key={pl.id}
                      className={`btn btn-sm ${u.plan === pl.id ? "" : "btn-ghost"}`}
                      disabled={busy || u.plan === pl.id}
                      onClick={() => run(() => api.admin.setPlan(id, pl.id))}
                    >
                      {t(pl.name)} · {pl.credits.toLocaleString("en-US")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="admin-manage-block">
                <label className="admin-manage-label">{t("Role & access")}</label>
                <div className="admin-actions">
                  <button
                    className={`btn btn-sm ${u.is_admin ? "btn-danger" : ""}`}
                    disabled={busy || (isSelf && u.is_admin)}
                    title={isSelf && u.is_admin ? t("You cannot remove your own admin access.") : ""}
                    onClick={() => run(() => api.admin.setAdmin(id, !u.is_admin))}
                  >
                    {u.is_admin ? t("Revoke admin") : t("Make admin")}
                  </button>
                  <button
                    className={`btn btn-sm ${u.is_active ? "btn-danger" : ""}`}
                    disabled={busy || isSelf}
                    title={isSelf ? t("You cannot suspend your own account.") : ""}
                    onClick={() => run(() => api.admin.setSuspended(id, u.is_active))}
                  >
                    {u.is_active ? t("Suspend") : t("Reactivate")}
                  </button>
                </div>
              </div>

              <div className="admin-manage-block">
                <label className="admin-manage-label admin-danger-label">{t("Danger zone")}</label>
                {confirmDelete ? (
                  <div className="admin-actions">
                    <span className="admin-confirm-text">{t("Delete this account and all its projects?")}</span>
                    <button className="btn btn-sm btn-danger" disabled={busy} onClick={del}>{t("Yes, delete")}</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>{t("Cancel")}</button>
                  </div>
                ) : (
                  <button className="btn btn-sm btn-danger" disabled={busy || isSelf}
                    title={isSelf ? t("You cannot delete your own account.") : ""}
                    onClick={() => setConfirmDelete(true)}>
                    {t("Delete account")}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Projects */}
          <section className="panel">
            <div className="panel-head"><h2>{t("Projects")}{data.projects.length ? ` · ${data.projects.length}` : ""}</h2></div>
            {data.projects.length === 0 ? (
              <p className="muted">{t("No projects.")}</p>
            ) : (
              <div className="rows">
                {data.projects.map((p) => (
                  <Link className="row" key={p.id} href={`/projects/${p.id}`}>
                    <div>
                      <div className="row-title">{p.topic}</div>
                      <div className="row-sub">{p.keyword} · {fmtDate(p.created_at)}</div>
                    </div>
                    <span className={`stage stage-${p.stage}`}>{t(p.stage)}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Credit ledger */}
          <section className="panel">
            <div className="panel-head"><h2>{t("Credit history")}</h2></div>
            {data.ledger.length === 0 ? (
              <p className="muted">{t("No credit movements.")}</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table admin-ledger">
                  <thead>
                    <tr>
                      <th>{t("When")}</th>
                      <th>{t("Reason")}</th>
                      <th className="num">{t("Change")}</th>
                      <th className="num">{t("Balance")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ledger.map((e, i) => (
                      <tr key={i}>
                        <td className="admin-muted">{fmtDate(e.created_at)}</td>
                        <td>
                          <span className="admin-ledger-reason">{t(e.reason)}</span>
                          {e.detail && <span className="admin-ledger-detail">{e.detail}</span>}
                        </td>
                        <td className={`num admin-ledger-delta ${e.delta >= 0 ? "pos" : "neg"}`}>
                          {e.delta >= 0 ? "+" : ""}{e.delta.toLocaleString("en-US")}
                        </td>
                        <td className="num">{e.balance_after.toLocaleString("en-US")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}
