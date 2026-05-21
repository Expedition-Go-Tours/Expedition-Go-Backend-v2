import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  CalendarDays,
  CreditCard,
  CirclePlus,
  ChevronDown,
  Megaphone,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  ShieldCheck,
  Search,
  Settings,
  Star,
  Sun,
  TrendingUp,
  Users,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth/AuthProvider";
import { useTheme } from "@/hooks/useTheme";
import { getPrimaryRole } from "@/lib/rbac";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdminInput } from "@/components/ui/admin-input";
import { StatusPill, pillToneForRole } from "@/components/ui/status-pill";

const NAV_ITEMS = [
  { label: "Dashboard", to: "/admin", icon: LayoutDashboard, end: true },
  { label: "My Experiences", to: "/admin/tours/new", icon: CirclePlus },
  { label: "Bookings", to: "/admin/bookings", icon: CalendarDays },
  { label: "Manage Availability", to: "/admin/settings", icon: Settings, badge: "Live" },
  { label: "Customers", to: "/admin/users", icon: Users },
  { label: "Analytics", to: "/admin/analytics", icon: TrendingUp },
];

const SECONDARY_ITEMS = [
  { label: "Payments", icon: CreditCard },
  { label: "Reviews", icon: Star },
  { label: "Notifications", icon: Megaphone },
];

function getInitials(value) {
  if (!value) return "U";
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Sidebar({ open, onClose }) {
  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-sm lg:hidden",
          open ? "block" : "hidden",
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          "admin-sidebar admin-scroll fixed inset-y-0 left-0 z-50 flex h-screen w-72 flex-col gap-6 overflow-y-auto overscroll-contain border-r border-white/10 px-4 pb-6 pt-5 transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between gap-3 px-2">
          <Link to="/admin" className="flex items-center gap-3" onClick={onClose}>
            <div className="grid size-14 place-items-center rounded-full border border-white/20 bg-slate-950/40 text-lg font-black text-emerald-300">
              EG
            </div>
            <div className="leading-tight">
              <p className="text-[1.65rem] font-black uppercase tracking-tight text-white">Expedition</p>
              <p className="text-[1.65rem] -mt-2 font-black uppercase tracking-tight text-emerald-400">Go Tours</p>
              <p className="text-lg font-bold text-emerald-300">Supplier Portal</p>
            </div>
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-300 hover:bg-white/5 lg:hidden"
            aria-label="Close menu"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-3">
          {NAV_ITEMS.map(({ label, to, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-3 rounded-2xl border border-transparent px-4 py-3.5 text-slate-200 transition-all",
                  "hover:border-white/15 hover:bg-white/5 hover:text-white",
                  isActive &&
                    "border-emerald-300/40 bg-gradient-to-r from-emerald-500 via-emerald-500/95 to-emerald-400 text-white shadow-[0_16px_38px_rgba(16,185,129,0.34)]",
                )
              }
            >
              <span className="grid size-9 place-items-center rounded-xl bg-white/12 text-emerald-200 group-hover:bg-white/18">
                <Icon className="size-4" />
              </span>
              <span className="text-sm font-semibold tracking-tight">{label}</span>
              {badge ? (
                <span className="ml-auto rounded-full border border-white/25 bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-100">
                  {badge}
                </span>
              ) : null}
            </NavLink>
          ))}

          <div className="space-y-2 pt-1">
            {SECONDARY_ITEMS.map(({ label, icon: Icon }) => (
              <button
                key={label}
                type="button"
                className="group flex w-full items-center gap-3 rounded-2xl border border-transparent px-4 py-3 text-left text-sm font-semibold text-slate-200 transition hover:border-white/15 hover:bg-white/5 hover:text-white"
              >
                <span className="grid size-9 place-items-center rounded-xl bg-white/12 text-slate-200 group-hover:bg-white/18">
                  <Icon className="size-4" />
                </span>
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="rounded-2xl border border-white/20 bg-white/10 p-4 text-slate-100">
          <p className="text-xl font-bold">Expedition Go Tours ✅</p>
          <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-emerald-300" /> Verified Supplier
          </p>
          <p className="mt-2 text-sm text-slate-200">Ghana</p>
          <p className="mt-1 text-sm text-slate-300">Member since Jan 2024</p>
        </div>
      </aside>
    </>
  );
}

function ThemeToggle() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle theme"
      className="grid size-10 place-items-center rounded-full border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] text-[color:var(--admin-text-soft)] transition hover:bg-[color:var(--admin-border-soft)]"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const role = getPrimaryRole(user);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  async function handleSignOut() {
    await signOut();
    navigate("/signin");
  }

  return (
    <div data-admin-app className="min-h-screen">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-h-screen min-w-0 flex-col lg:pl-72">
        <header className="sticky top-0 z-30 border-b border-[color:var(--admin-border)] bg-[color:var(--admin-panel)]/85 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="grid size-10 place-items-center rounded-full border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] text-[color:var(--admin-text-soft)] lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-4" />
            </button>

            <div className="hidden flex-1 items-center sm:flex">
              <div className="relative w-full max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--admin-muted)]" />
                <AdminInput
                  placeholder="Search bookings, users, tours..."
                  className="pl-9"
                />
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="relative grid size-10 place-items-center rounded-full border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] text-[color:var(--admin-text-soft)]"
                aria-label="Notifications"
              >
                <Bell className="size-4" />
                <span className="absolute right-2 top-2 size-2 rounded-full bg-emerald-500" />
              </button>
              <ThemeToggle />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-full border border-[color:var(--admin-border)] bg-[color:var(--admin-panel)] py-1 pl-1 pr-3 text-sm font-semibold text-[color:var(--admin-text)] transition hover:bg-[color:var(--admin-border-soft)]"
                  >
                    <Avatar className="size-8">
                      <AvatarImage src={user?.photoURL || undefined} alt={user?.name || "User"} />
                      <AvatarFallback>{getInitials(user?.name || user?.email)}</AvatarFallback>
                    </Avatar>
                    <span className="hidden flex-col text-left leading-tight sm:flex">
                      <span className="text-sm font-semibold">{user?.name || "Admin"}</span>
                      <span className="text-[11px] uppercase tracking-wider text-[color:var(--admin-muted)]">
                        {role}
                      </span>
                    </span>
                    <ChevronDown className="size-3.5 text-[color:var(--admin-muted)]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold normal-case tracking-normal text-[color:var(--admin-text)]">
                        {user?.name || "Admin"}
                      </span>
                      <span className="text-xs normal-case tracking-normal text-[color:var(--admin-muted)]">
                        {user?.email}
                      </span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate("/admin/settings")}>
                    <Settings className="size-4" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleSignOut} className="text-[color:var(--admin-danger)]">
                    <LogOut className="size-4" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main className="admin-fade-in flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mb-5 flex flex-wrap items-end justify-end gap-3">
            <StatusPill tone={pillToneForRole(role)}>{role}</StatusPill>
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
