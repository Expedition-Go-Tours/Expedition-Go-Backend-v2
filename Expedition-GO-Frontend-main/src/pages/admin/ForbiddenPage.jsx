import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md rounded-2xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] p-8 text-center shadow-[var(--admin-shadow-soft)]">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-[color:var(--admin-warning-soft)] text-[color:var(--admin-warning)]">
          <ShieldAlert className="size-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-[color:var(--admin-text)]">Access restricted</h2>
        <p className="mt-2 text-sm text-[color:var(--admin-muted)]">
          You don&apos;t have permission to view this section. If you believe this is a mistake,
          please contact your workspace administrator.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            to="/admin"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-[color:var(--admin-brand)] px-4 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(15,159,122,0.25)] hover:bg-[color:var(--admin-brand-dark)]"
          >
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
