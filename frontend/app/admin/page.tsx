"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { api } from "../../lib/api";
import { useLang } from "../../lib/i18n";
import type { AdminProject, AdminSort, AdminStats, AdminUser, SortOrder } from "../../lib/types";

const PAGE = 25;
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

const fmtDate = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export default function AdminPage() {
  const { t } = useLang();
  const [denied, setDenied] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [recent, setRecent] = useState<AdminProject[]>([]);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<AdminSort>("joined");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [offset, setOffset] = useState(0);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadUsers = useCallback(
    async (query: string, s: AdminSort, o: SortOrder, off: number) => {
      const r = await api.admin.users({ q: query, sort: s, order: o, limit: PAGE, offset: off });
      setUsers(r.users);
      setTotal(r.total);
    },
    [],
  );

  const refreshStats = useCallback(() => {
    api.admin.stats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const u = await api.auth.me();
        setMeId(u.id);
        if (!u.is_admin) {
          setDenied(true);
          return;
        }
        await Promise.all([
          api.admin.stats().then(setStats),
          loadUsers("", "joined", "desc", 0),
          api.admin.recentProjects(8).then(setRecent),
        ]);
      } catch (e) {
        setErr(msg(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadUsers]);

  // Re-fetch on search / sort / page change (search debounced).
  useEffect(() => {
    if (denied || loading) return;
    const id = window.setTimeout(() => {
      loadUsers(q, sort, order, offset).catch((e) => setErr(msg(e)));
    }, 200);
    return () => window.clearTimeout(id);
  }, [q, sort, order, offset, denied, loading, loadUsers]);

  function toggleSort(col: AdminSort) {
    setOffset(0);
    if (sort === col) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(col);
      setOrder(col === "joined" || col === "credits" || col === "projects" ? "desc" : "asc");
    }
  }

  const patchRow = (u: AdminUser) => setUsers((prev) => prev.map((x) => (x.id === u.id ? u : x)));

  async function applyCredits(u: AdminUser) {
    const d = parseInt(delta, 10);
    if (!Number.isFinite(d) || d === 0) {
      setEditing(null);
      return;
    }
    setBusyId(u.id);
    setErr(null);
    try {
      patchRow(await api.admin.setCredits(u.id, d, reason.trim() || undefined));
      setEditing(null);
      refreshStats();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAdmin(u: AdminUser) {
    setBusyId(u.id);
    setErr(null);
    try {
      patchRow(await api.admin.setAdmin(u.id, !u.is_admin));
      refreshStats();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusyId(null);
    }
  }

  if (denied) {
    return (
      <Shell title="Admin">
        <section className="panel admin-denied">
          <h2>{t("Admins only")}</h2>
          <p className="muted">{t("This area is restricted to platform administrators.")}</p>
          <Link className="btn" href="/dashboard">{t("Back to dashboard")}</Link>
        </section>
      </Shell>
    );
  }

  const cards = stats
    ? [
        { label: "Users", value: stats.users_total, sub: `${stats.users_new_7d} ${t("new this week")}` },
        { label: "Admins", value: stats.users_admins },
        { label: "Suspended", value: stats.users_suspended },
        { label: "Projects", value: stats.projects_total },
        { label: "Runs", value: stats.runs_total },
        { label: "Credits outstanding", value: stats.credits_outstanding, sub: `${stats.credits_granted.toLocaleString("en-US")} ${t("granted")}` },
      ]
    : [];

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);
  const arrow = (col: AdminSort) => (sort === col ? (order === "asc" ? " ↑" : " ↓") : "");

  return (
    <Shell title="Admin" status={<span className="pill ok">{t("admin")}</span>}>
      {err && <p className="error">{err}</p>}

      <section className="metrics admin-metrics">
        {loading && !stats
          ? Array.from({ length: 6 }).map((_, i) => <div className="card metric admin-skel" key={i} />)
          : cards.map((c) => (
              <div className="card metric" key={c.label}>
                <div className="metric-value">{c.value.toLocaleString("en-US")}</div>
                <div className="metric-label">{t(c.label)}</div>
                {c.sub && <div className="admin-metric-sub">{c.sub}</div>}
              </div>
            ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{t("Users")}{total ? ` · ${total}` : ""}</h2>
          <input
            className="admin-search"
            type="search"
            placeholder={t("Search email or name…")}
            value={q}
            onChange={(e) => { setOffset(0); setQ(e.target.value); }}
          />
        </div>

        {loading ? (
          <p className="muted">{t("Loading…")}</p>
        ) : users.length === 0 ? (
          <p className="muted">{t("No users match.")}</p>
        ) : (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>{t("User")}</th>
                    <th className="admin-sortable" onClick={() => toggleSort("joined")}>{t("Joined")}{arrow("joined")}</th>
                    <th className="num admin-sortable" onClick={() => toggleSort("projects")}>{t("Projects")}{arrow("projects")}</th>
                    <th className="num admin-sortable" onClick={() => toggleSort("credits")}>{t("Credits")}{arrow("credits")}</th>
                    <th>{t("Status")}</th>
                    <th className="admin-actions-col">{t("Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === meId;
                    const rowBusy = busyId === u.id;
                    return (
                      <tr key={u.id} className={`${rowBusy ? "admin-row-busy" : ""} ${!u.is_active ? "admin-row-suspended" : ""}`}>
                        <td>
                          <Link href={`/admin/users/${u.id}`} className="admin-user">
                            <span className="admin-avatar">{(u.name || u.email).charAt(0).toUpperCase()}</span>
                            <div className="admin-user-meta">
                              <span className="admin-user-name">
                                {u.name || u.email.split("@")[0]}
                                {isSelf && <span className="admin-you">{t("you")}</span>}
                              </span>
                              <span className="admin-user-email">{u.email}</span>
                            </div>
                          </Link>
                        </td>
                        <td className="admin-muted">{fmtDate(u.created_at)}</td>
                        <td className="num">{u.projects}</td>
                        <td className="num">
                          {editing === u.id ? (
                            <div className="admin-credit-edit">
                              <input
                                className="admin-credit-input"
                                type="number"
                                autoFocus
                                value={delta}
                                placeholder="±"
                                onChange={(e) => setDelta(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") applyCredits(u);
                                  if (e.key === "Escape") setEditing(null);
                                }}
                              />
                              <input
                                className="admin-reason-input"
                                type="text"
                                value={reason}
                                placeholder={t("reason (optional)")}
                                onChange={(e) => setReason(e.target.value)}
                              />
                              <button className="btn btn-sm" disabled={rowBusy} onClick={() => applyCredits(u)}>{t("Apply")}</button>
                              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>{t("Cancel")}</button>
                            </div>
                          ) : (
                            <span className="admin-credits">{u.credits.toLocaleString("en-US")}</span>
                          )}
                        </td>
                        <td>
                          {!u.is_active ? (
                            <span className="tag tag-red">{t("Suspended")}</span>
                          ) : u.effective_admin ? (
                            <span className="tag tag-green">{t("Admin")}</span>
                          ) : (
                            <span className="tag">{t("Member")}</span>
                          )}
                        </td>
                        <td className="admin-actions-col">
                          {editing !== u.id && (
                            <div className="admin-actions">
                              <button className="btn btn-sm btn-ghost" disabled={rowBusy} onClick={() => { setEditing(u.id); setDelta(""); setReason(""); }}>
                                {t("Credits")}
                              </button>
                              <button
                                className={`btn btn-sm ${u.is_admin ? "btn-danger" : "btn-ghost"}`}
                                disabled={rowBusy || (isSelf && u.is_admin)}
                                title={isSelf && u.is_admin ? t("You cannot remove your own admin access.") : ""}
                                onClick={() => toggleAdmin(u)}
                              >
                                {u.is_admin ? t("Revoke") : t("Make admin")}
                              </button>
                              <Link href={`/admin/users/${u.id}`} className="btn btn-sm btn-ghost">{t("Open")}</Link>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="admin-pager">
              <span className="admin-pager-info">{t("Showing")} {from}–{to} {t("of")} {total}</span>
              <div className="admin-pager-btns">
                <button className="btn btn-sm btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← {t("Prev")}</button>
                <button className="btn btn-sm btn-ghost" disabled={to >= total} onClick={() => setOffset(offset + PAGE)}>{t("Next")} →</button>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>{t("Recent projects")}</h2></div>
        {recent.length === 0 ? (
          <p className="muted">{t("No projects yet.")}</p>
        ) : (
          <div className="rows">
            {recent.map((p) => (
              <Link className="row" key={p.id} href={`/projects/${p.id}`}>
                <div>
                  <div className="row-title">{p.topic}</div>
                  <div className="row-sub">{p.owner_email || t("no owner")} · {p.keyword} · {fmtDate(p.created_at)}</div>
                </div>
                <span className={`stage stage-${p.stage}`}>{t(p.stage)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}
