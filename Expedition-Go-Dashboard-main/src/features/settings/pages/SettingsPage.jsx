import { useState } from "react";
import {
  Building2,
  Bell,
  Key,
  Plug,
  ClipboardList,
  Upload,
  Copy,
  Check,
  Globe,
  Clock,
  Mail,
  MessageSquare,
  Save,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

const SETTINGS_TABS = [
  { key: "company", label: "Company Profile", icon: Building2 },
  { key: "notifications", label: "Notification Preferences", icon: Bell },
  { key: "api", label: "API Keys", icon: Key },
  { key: "integrations", label: "Integrations", icon: Plug },
  { key: "audit", label: "Audit Log", icon: ClipboardList },
];

const AUDIT_LOG = [
  { id: "AUD-001", action: "Updated company profile", user: "Admin User", timestamp: "2026-05-18T14:30:00", type: "update" },
  { id: "AUD-002", action: "Approved review REV-002", user: "Jane Manager", timestamp: "2026-05-18T12:15:00", type: "approve" },
  { id: "AUD-003", action: "Created new admin user", user: "Admin User", timestamp: "2026-05-17T16:20:00", type: "create" },
  { id: "AUD-004", action: "Updated Stripe API key", user: "Admin User", timestamp: "2026-05-17T10:45:00", type: "update" },
  { id: "AUD-005", action: "Suspended supplier USR-005", user: "Jane Manager", timestamp: "2026-05-16T15:30:00", type: "suspend" },
  { id: "AUD-006", action: "Deleted product PRD-012", user: "Admin User", timestamp: "2026-05-15T09:00:00", type: "delete" },
  { id: "AUD-007", action: "Updated booking status", user: "Jane Manager", timestamp: "2026-05-14T11:20:00", type: "update" },
  { id: "AUD-008", action: "Invited new admin", user: "Admin User", timestamp: "2026-05-13T14:00:00", type: "create" },
];

const INTEGRATIONS = [
  { name: "Stripe", description: "Payment processing", connected: true, lastSync: "2026-05-18T10:00:00" },
  { name: "Firebase", description: "Authentication & notifications", connected: true, lastSync: "2026-05-18T08:00:00" },
  { name: "SendGrid", description: "Email delivery", connected: true, lastSync: "2026-05-17T16:00:00" },
  { name: "Google Analytics", description: "Web analytics", connected: false, lastSync: null },
  { name: "Zendesk", description: "Customer support", connected: false, lastSync: null },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("company");
  const [copied, setCopied] = useState(null);

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Settings</h1>
        <p className="text-sm text-[#64748b] mt-1">Manage your account and platform settings</p>
      </div>

      {/* Settings Layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Sidebar Tabs */}
        <div className="w-full lg:w-64 flex-shrink-0">
          <div className="flex lg:flex-col overflow-x-auto lg:overflow-visible gap-1 pb-2 lg:pb-0">
            {SETTINGS_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`w-auto lg:w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    activeTab === tab.key
                      ? "bg-[#044b3b] text-white"
                      : "text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b]"
                  }`}
                >
                  <Icon size={18} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1">
          {/* Company Profile */}
          {activeTab === "company" && (
            <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6 space-y-6">
              <h2 className="text-lg font-semibold text-[#1e293b]">Company Profile</h2>

              {/* Logo Upload */}
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">Company Logo</label>
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-lg bg-[#f8fafc] border border-[#eaeaea] flex items-center justify-center">
                    <Building2 size={32} className="text-[#9e9e9e]" />
                  </div>
                  <div>
                    <button className="flex items-center gap-2 px-4 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#64748b] hover:bg-[#f8fafc] transition-colors">
                      <Upload size={16} />
                      Upload Logo
                    </button>
                    <p className="text-xs text-[#9e9e9e] mt-1">Recommended: 200x200px PNG or SVG</p>
                  </div>
                </div>
              </div>

              {/* Company Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-[#1e293b] mb-2">Company Name</label>
                  <input
                    type="text"
                    defaultValue="TravioAfrica"
                    className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1e293b] mb-2">Email</label>
                  <input
                    type="email"
                    defaultValue="info@travioafrica.com"
                    className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1e293b] mb-2">Phone</label>
                  <input
                    type="tel"
                    defaultValue="+255 123 456 789"
                    className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1e293b] mb-2">Website</label>
                  <input
                    type="url"
                    defaultValue="https://travioafrica.com"
                    className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
              </div>

              {/* Address */}
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">Address</label>
                <textarea
                  rows={3}
                  defaultValue="123 Safari Road, Arusha, Tanzania"
                  className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
                />
              </div>

              {/* Timezone & Currency */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-[#1e293b] mb-2">Timezone</label>
                  <select className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]">
                    <option>Africa/Dar_es_Salaam (EAT)</option>
                    <option>UTC</option>
                    <option>America/New_York (EST)</option>
                    <option>Europe/London (GMT)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1e293b] mb-2">Default Currency</label>
                  <select className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]">
                    <option>USD ($)</option>
                    <option>EUR (€)</option>
                    <option>GBP (£)</option>
                    <option>ZAR (R)</option>
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-[#eaeaea]">
                <button className="flex items-center gap-2 px-5 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors">
                  <Save size={16} />
                  Save Changes
                </button>
              </div>
            </div>
          )}

          {/* Notification Preferences */}
          {activeTab === "notifications" && (
            <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6 space-y-6">
              <h2 className="text-lg font-semibold text-[#1e293b]">Notification Preferences</h2>

              {[
                { title: "New Bookings", desc: "Get notified when a new booking is made", email: true, push: true },
                { title: "Booking Cancellations", desc: "Get notified when a booking is cancelled", email: true, push: true },
                { title: "Reviews Pending Approval", desc: "Get notified when a review needs moderation", email: true, push: false },
                { title: "Supplier Applications", desc: "Get notified when a supplier applies", email: true, push: true },
                { title: "Payment Failures", desc: "Get notified when a payment fails", email: true, push: true },
                { title: "Low Availability", desc: "Get notified when a tour has low availability", email: false, push: true },
                { title: "System Maintenance", desc: "Get notified about scheduled maintenance", email: true, push: false },
                { title: "Weekly Summary", desc: "Receive a weekly summary of your business", email: true, push: false },
              ].map((pref) => (
                <div key={pref.title} className="flex flex-col sm:flex-row sm:items-center justify-between py-3 border-b border-[#eaeaea] last:border-0 gap-3">
                  <div>
                    <p className="text-sm font-medium text-[#1e293b]">{pref.title}</p>
                    <p className="text-xs text-[#64748b]">{pref.desc}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" defaultChecked={pref.email} className="w-4 h-4 rounded border-[#eaeaea] text-[#044b3b] focus:ring-[#044b3b]" />
                      <Mail size={14} className="text-[#64748b]" />
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" defaultChecked={pref.push} className="w-4 h-4 rounded border-[#eaeaea] text-[#044b3b] focus:ring-[#044b3b]" />
                      <Bell size={14} className="text-[#64748b]" />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* API Keys */}
          {activeTab === "api" && (
            <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6 space-y-6">
              <h2 className="text-lg font-semibold text-[#1e293b]">API Keys</h2>
              <p className="text-sm text-[#64748b]">Manage API keys for integrations and webhooks</p>

              {[
                { name: "Stripe Secret Key", key: "sk_live_51H...xYz123", id: "stripe-secret" },
                { name: "Stripe Publishable Key", key: "pk_live_51H...xYz456", id: "stripe-pub" },
                { name: "Firebase API Key", key: "AIzaSyB...xYz789", id: "firebase" },
                { name: "Webhook Secret", key: "whsec_...xYzabc", id: "webhook" },
              ].map((apiKey) => (
                <div key={apiKey.id} className="p-4 bg-[#f8fafc] rounded-lg border border-[#eaeaea]">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-[#1e293b]">{apiKey.name}</p>
                    <button
                      onClick={() => copyToClipboard(apiKey.key, apiKey.id)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs text-[#044b3b] bg-white border border-[#eaeaea] rounded-md hover:bg-[#f0fdf4] transition-colors"
                    >
                      {copied === apiKey.id ? <Check size={12} /> : <Copy size={12} />}
                      {copied === apiKey.id ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-white rounded border border-[#eaeaea] text-xs font-mono text-[#1e293b]">
                      {apiKey.key}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Integrations */}
          {activeTab === "integrations" && (
            <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6 space-y-6">
              <h2 className="text-lg font-semibold text-[#1e293b]">Integrations</h2>
              <p className="text-sm text-[#64748b]">Connect third-party services to your platform</p>

              <div className="space-y-4">
                {INTEGRATIONS.map((integration) => (
                  <div key={integration.name} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-[#f8fafc] rounded-lg border border-[#eaeaea] gap-4">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${integration.connected ? "bg-[#ebfcf5]" : "bg-[#f8fafc]"}`}>
                        <Plug size={20} className={integration.connected ? "text-[#00d67f]" : "text-[#9e9e9e]"} />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#1e293b]">{integration.name}</p>
                        <p className="text-xs text-[#64748b]">{integration.description}</p>
                        {integration.connected && integration.lastSync && (
                          <p className="text-xs text-[#00d67f]">Last synced: {formatDateTime(integration.lastSync)}</p>
                        )}
                      </div>
                    </div>
                    <button
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        integration.connected
                          ? "bg-[#ffebeb] text-[#dc3545] hover:bg-[#fee2e2]"
                          : "bg-[#044b3b] text-white hover:bg-[#033629]"
                      }`}
                    >
                      {integration.connected ? "Disconnect" : "Connect"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Audit Log */}
          {activeTab === "audit" && (
            <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6">
              <h2 className="text-lg font-semibold text-[#1e293b] mb-4">Audit Log</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#eaeaea] bg-[#f8fafc]">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Action</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">User</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Timestamp</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {AUDIT_LOG.map((entry) => (
                      <tr key={entry.id} className="border-b border-[#eaeaea] hover:bg-[#f8fafc] transition-colors">
                        <td className="px-4 py-3 text-[#1e293b]">{entry.action}</td>
                        <td className="px-4 py-3 text-[#64748b]">{entry.user}</td>
                        <td className="px-4 py-3 text-[#64748b]">{formatDateTime(entry.timestamp)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            entry.type === "create" ? "bg-[#ebfcf5] text-[#047857]" :
                            entry.type === "update" ? "bg-[#eff6ff] text-[#1d4ed8]" :
                            entry.type === "delete" ? "bg-[#ffebeb] text-[#b91c1c]" :
                            "bg-[#fffbeb] text-[#b45309]"
                          }`}>
                            {entry.type}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
