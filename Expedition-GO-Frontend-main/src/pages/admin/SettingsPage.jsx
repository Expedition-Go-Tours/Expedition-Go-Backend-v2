import { Moon, Sun } from "lucide-react";

import {
  AdminCard,
  AdminCardContent,
  AdminCardDescription,
  AdminCardHeader,
  AdminCardTitle,
} from "@/components/ui/admin-card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { AdminButton } from "@/components/ui/admin-button";
import { AdminInput, AdminLabel } from "@/components/ui/admin-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/components/auth/AuthProvider";
import { useTheme } from "@/hooks/useTheme";
import { getPrimaryRole } from "@/lib/rbac";
import { StatusPill, pillToneForRole } from "@/components/ui/status-pill";

function getInitials(value) {
  if (!value) return "U";
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function SettingsPage() {
  const { user } = useAuth();
  const { isDark, toggleTheme, setTheme } = useTheme();
  const role = getPrimaryRole(user);

  return (
    <div className="grid gap-5">
      <Tabs defaultValue="profile" className="w-full">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <AdminCard>
            <AdminCardHeader>
              <div>
                <AdminCardTitle>Profile</AdminCardTitle>
                <AdminCardDescription>Update your basic account information.</AdminCardDescription>
              </div>
              <StatusPill tone={pillToneForRole(role)}>{role}</StatusPill>
            </AdminCardHeader>
            <AdminCardContent>
              <div className="flex items-center gap-4">
                <Avatar className="size-14">
                  <AvatarImage src={user?.photoURL || undefined} alt={user?.name || "User"} />
                  <AvatarFallback>{getInitials(user?.name || user?.email)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-base font-bold text-[color:var(--admin-text)]">{user?.name || "Admin"}</p>
                  <p className="text-sm text-[color:var(--admin-muted)]">{user?.email || "—"}</p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <AdminLabel htmlFor="profile-name">Display name</AdminLabel>
                  <AdminInput id="profile-name" defaultValue={user?.name || ""} />
                </div>
                <div className="grid gap-1.5">
                  <AdminLabel htmlFor="profile-email">Email</AdminLabel>
                  <AdminInput id="profile-email" type="email" defaultValue={user?.email || ""} disabled />
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <AdminButton type="button" disabled>
                  Save changes
                </AdminButton>
              </div>
            </AdminCardContent>
          </AdminCard>
        </TabsContent>

        <TabsContent value="appearance">
          <AdminCard>
            <AdminCardHeader>
              <div>
                <AdminCardTitle>Appearance</AdminCardTitle>
                <AdminCardDescription>Choose how the dashboard looks for you.</AdminCardDescription>
              </div>
            </AdminCardHeader>
            <AdminCardContent>
              <div className="flex items-center justify-between rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-lg bg-[color:var(--admin-brand-soft)] text-[color:var(--admin-brand-dark)]">
                    {isDark ? <Moon className="size-5" /> : <Sun className="size-5" />}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--admin-text)]">Dark mode</p>
                    <p className="text-xs text-[color:var(--admin-muted)]">
                      Stored locally and applied across admin sessions.
                    </p>
                  </div>
                </div>
                <Switch checked={isDark} onCheckedChange={toggleTheme} aria-label="Toggle dark mode" />
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className="rounded-xl border border-[color:var(--admin-border)] bg-white p-4 text-left text-sm font-semibold text-slate-900 transition hover:border-[color:var(--admin-brand)]"
                  onClick={() => setTheme("light")}
                >
                  <p>Light</p>
                  <p className="mt-1 text-xs font-normal text-slate-500">Bright, clean working surface.</p>
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-slate-700 bg-slate-900 p-4 text-left text-sm font-semibold text-white transition hover:border-emerald-400"
                  onClick={() => setTheme("dark")}
                >
                  <p>Dark</p>
                  <p className="mt-1 text-xs font-normal text-slate-400">Reduced eye strain at night.</p>
                </button>
              </div>
            </AdminCardContent>
          </AdminCard>
        </TabsContent>

        <TabsContent value="system">
          <AdminCard>
            <AdminCardHeader>
              <div>
                <AdminCardTitle>System</AdminCardTitle>
                <AdminCardDescription>Operational settings and feature flags.</AdminCardDescription>
              </div>
            </AdminCardHeader>
            <AdminCardContent>
              <ul className="grid gap-2">
                <li className="flex items-center justify-between rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--admin-text)]">Email notifications</p>
                    <p className="text-xs text-[color:var(--admin-muted)]">
                      Receive booking and payment alerts to your inbox.
                    </p>
                  </div>
                  <Switch defaultChecked aria-label="Toggle email notifications" />
                </li>
                <li className="flex items-center justify-between rounded-xl border border-[color:var(--admin-border)] bg-[color:var(--admin-panel-2)] p-4">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--admin-text)]">Auto-confirm bookings</p>
                    <p className="text-xs text-[color:var(--admin-muted)]">
                      Confirm bookings automatically when payment is captured.
                    </p>
                  </div>
                  <Switch aria-label="Toggle auto-confirm" />
                </li>
              </ul>
            </AdminCardContent>
          </AdminCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
