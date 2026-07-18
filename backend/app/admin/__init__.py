"""Admin panel API — user administration + platform stats.

Every route is gated by :func:`app.security.require_admin` (DB ``is_admin`` flag or
the ``ADMIN_EMAILS`` allow-list). This is a separate concern from the per-project
owner scoping used elsewhere: admins deliberately see across all accounts.
"""
