import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  User,
  Bell,
  CreditCard,
  Mail,
  Smartphone,
  Tag,
  Trash2,
  Plus,
  Shield,
  Check,
  ChevronRight,
} from "lucide-react";
import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";

/* ------------------------------------------------------------------ */
/*  Shared animation presets                                           */
/* ------------------------------------------------------------------ */
const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.28, ease: "easeOut" },
};

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.06 } },
};

const staggerItem = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.25, ease: "easeOut" },
};

/* ------------------------------------------------------------------ */
/*  Toggle switch (replaces checkbox)                                  */
/* ------------------------------------------------------------------ */
function ToggleSwitch({ checked, onChange, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand-green)]/30 ${
        checked
          ? "bg-[color:var(--brand-green)]"
          : "bg-slate-300"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <span
        className={`inline-block size-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Form input wrapper                                                 */
/* ------------------------------------------------------------------ */
function FormField({ label, children, hint }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[13px] font-semibold tracking-wide text-slate-700 uppercase">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function TextInput({ value, onChange, name, placeholder, type = "text", disabled = false }) {
  return (
    <input
      type={type}
      name={name}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder}
      className={`w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm transition-all placeholder:text-slate-400 hover:border-slate-300 focus:border-[color:var(--brand-green)] focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-green)]/15 ${
        disabled ? "cursor-not-allowed bg-slate-50 text-slate-400" : ""
      }`}
    />
  );
}

function SelectInput({ value, onChange, name, placeholder, options }) {
  return (
    <div className="relative">
      <select
        name={name}
        value={value}
        onChange={onChange}
        className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm transition-all hover:border-slate-300 focus:border-[color:var(--brand-green)] focus:outline-none focus:ring-2 focus:ring-[color:var(--brand-green)]/15"
      >
        <option value="">{placeholder}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronRight className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 rotate-90 text-slate-400" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab definitions                                                    */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */
export default function SettingsPage() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const TABS = [
    { id: "personal", label: t("settings.tabPersonal"), icon: User },
    { id: "notifications", label: t("settings.tabNotifications"), icon: Bell },
    { id: "payment", label: t("settings.tabPayment"), icon: CreditCard },
  ];
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [activeTab, setActiveTab] = useState("personal");
  const [isMobile, setIsMobile] = useState(false);

  /* form state */
  const [formData, setFormData] = useState({
    firstName: user?.name?.split(" ")[0] || "",
    lastName: user?.name?.split(" ")[1] || "",
    email: user?.email || "",
    phone: "",
  });
  const [notifications, setNotifications] = useState({
    email: true,
    sms: true,
    marketing: false,
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [notificationChanges, setNotificationChanges] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [photoLoaded, setPhotoLoaded] = useState(false);

  /* viewport */
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  /* auth guard */
  useEffect(() => {
    if (loading) return;
    if (!user) navigate("/signin", { replace: true });
    else setIsAuthorized(true);
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user) {
      setFormData((prev) => ({
        ...prev,
        firstName: user.name?.split(" ")[0] || "",
        lastName: user.name?.split(" ")[1] || "",
        email: user.email || "",
      }));
    }
  }, [user]);

  useEffect(() => {
    setPhotoLoaded(false);
  }, [user?.photoURL]);

  if (loading || !isAuthorized) return null;

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setHasChanges(true);
  };

  const handleNotificationChange = (key) => {
    setNotifications((prev) => ({ ...prev, [key]: !prev[key] }));
    setNotificationChanges(true);
  };

  const handleSave = () => setHasChanges(false);
  const handleNotificationSave = () => setNotificationChanges(false);

  const userInitial = user?.name?.charAt(0).toUpperCase() || "U";

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Navbar />
      <div className="h-[58px] sm:h-[96px] lg:h-[104px]" />

      <main className="flex-1">
        {/* Hero header */}
        <div className="relative overflow-hidden border-b border-slate-200 bg-white">
          <div className="relative mx-auto max-w-[1520px] px-4 pb-10 pt-8 sm:px-6 sm:pb-12 sm:pt-10 lg:px-8">
            <button
              onClick={() => navigate(-1)}
              className="group mb-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-[color:var(--brand-green)]/30 hover:bg-[color:var(--brand-mist)] hover:text-[color:var(--brand-green)]"
            >
              <ArrowLeft className="size-4 transition group-hover:-translate-x-0.5" />
              Back
            </button>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              {t("settings.title")}
            </h1>
            <p className="mt-2 max-w-lg text-sm font-medium text-slate-500">
              {t("settings.subtitle")}
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-[1520px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
            {/* ─── Sidebar ─── */}
            <aside className="space-y-6">
              {/* Profile mini-card */}
              <div className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
                <div className="relative px-6 pb-6 pt-16 text-center">
                  {/* Decorative top arc */}
                  <div className="absolute inset-x-0 top-0 h-28 bg-slate-900" />
                  <div className="absolute inset-x-0 top-[6.5rem] h-12 bg-white rounded-t-[2rem]" />

                  {/* Avatar — centered, larger */}
                  <div className="relative mx-auto mb-4 size-28">
                    {/* Skeleton / fallback placeholder */}
                    <div
                      className={`absolute inset-0 grid place-items-center rounded-full border-[6px] border-white bg-slate-200 shadow-lg transition-opacity duration-300 ${photoLoaded ? "opacity-0" : "opacity-100"}`}
                    >
                      <User className="size-16 text-black" strokeWidth={1.5} />
                    </div>

                    {user?.photoURL && (
                      <img
                        src={user.photoURL}
                        alt={user.name}
                        onLoad={() => setPhotoLoaded(true)}
                        className={`absolute inset-0 size-28 rounded-full border-[6px] border-white object-cover shadow-lg transition-opacity duration-300 ${photoLoaded ? "opacity-100" : "opacity-0"}`}
                      />
                    )}

                    {/* Online / verified dot */}
                    <div className="absolute bottom-1 right-1/2 translate-x-10 grid size-6 place-items-center rounded-full border-2 border-white bg-emerald-500">
                      <Shield className="size-3 text-white" />
                    </div>
                  </div>

                  <h2 className="text-lg font-bold text-slate-900">{user?.name || "User"}</h2>
                  <p className="mt-0.5 text-sm text-slate-500">{user?.email}</p>
                  <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                    {t("settings.verifiedAccount")}
                  </div>
                </div>
              </div>

              {/* Tab navigation */}
              <nav className="space-y-1 rounded-2xl border border-slate-200/60 bg-white p-2 shadow-sm">
                {TABS.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`group relative flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium transition-all ${
                        isActive
                          ? "bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                      }`}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="activeTab"
                          className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-[color:var(--brand-green)]"
                          transition={{ type: "spring", stiffness: 500, damping: 35 }}
                        />
                      )}
                      <Icon className={`size-[18px] transition ${isActive ? "text-[color:var(--brand-green)]" : "text-slate-400 group-hover:text-slate-600"}`} />
                      <span>{tab.label}</span>
                      {isActive && (
                        <ChevronRight className="ml-auto size-4 text-[color:var(--brand-green)]" />
                      )}
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* ─── Main Content ─── */}
            <div className="min-w-0">
              <AnimatePresence mode="wait">
                {activeTab === "personal" && (
                  <motion.div
                    key="personal"
                    {...fadeUp}
                    className="space-y-6"
                  >
                    {/* Profile section */}
                    <section className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
                      <div className="border-b border-slate-100 px-6 py-5 sm:px-8">
                        <div className="flex items-center gap-3">
                          <div className="grid size-10 place-items-center rounded-xl bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]">
                            <User className="size-5" />
                          </div>
                          <div>
                            <h2 className="text-lg font-bold text-slate-900">{t("settings.profileDetails")}</h2>
                            <p className="text-sm text-slate-500">{t("settings.profileDetailsDesc")}</p>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-6 p-6 sm:p-8">
                        <div className="grid gap-6 sm:grid-cols-2">
                          <FormField label={t("settings.firstName")}>
                            <TextInput
                              name="firstName"
                              value={formData.firstName}
                              onChange={handleInputChange}
                              placeholder="Enter your first name"
                            />
                          </FormField>
                          <FormField label={t("settings.lastName")}>
                            <TextInput
                              name="lastName"
                              value={formData.lastName}
                              onChange={handleInputChange}
                              placeholder="Enter your last name"
                            />
                          </FormField>
                        </div>

                        <div className="grid gap-6 sm:grid-cols-2">
                          <FormField label={t("settings.email")} hint={t("settings.emailHint")}>
                            <TextInput
                              name="email"
                              value={formData.email}
                              onChange={() => {}}
                              placeholder="your@email.com"
                              disabled
                            />
                          </FormField>
                          <FormField label={t("settings.mobilePhone")}>
                            <TextInput
                              name="phone"
                              type="tel"
                              value={formData.phone}
                              onChange={handleInputChange}
                              placeholder="+1 234 567 890"
                            />
                          </FormField>
                        </div>

                        <div className="flex items-center justify-between border-t border-slate-100 pt-6">
                          <p className="text-sm text-slate-500">
                            {hasChanges ? t("settings.unsavedChanges") : t("settings.allSaved")}
                          </p>
                          <button
                            onClick={handleSave}
                            disabled={!hasChanges}
                            className={`inline-flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-all ${
                              hasChanges
                                ? "bg-[color:var(--brand-green)] shadow-[color:var(--brand-green)]/20 hover:shadow-md hover:brightness-110 active:scale-[0.98]"
                                : "cursor-not-allowed bg-slate-300"
                            }`}
                          >
                            <Check className="size-4" />
                            {t("settings.saveChanges")}
                          </button>
                        </div>
                      </div>
                    </section>

                    {/* Danger zone */}
                    <section className="overflow-hidden rounded-2xl border border-rose-200/60 bg-white shadow-sm">
                      <div className="border-b border-rose-100 px-6 py-5 sm:px-8">
                        <div className="flex items-center gap-3">
                          <div className="grid size-10 place-items-center rounded-xl bg-rose-50 text-rose-600">
                            <Trash2 className="size-5" />
                          </div>
                          <div>
                            <h2 className="text-lg font-bold text-slate-900">{t("settings.deleteAccount")}</h2>
                            <p className="text-sm text-slate-500">{t("settings.deleteAccountDesc")}</p>
                          </div>
                        </div>
                      </div>
                      <div className="p-6 sm:p-8">
                        <p className="mb-5 text-sm leading-relaxed text-slate-600">
                          Once you delete your account, there is no going back. All your bookings, wishlists, and personal data will be permanently removed.
                        </p>
                        {!showDeleteConfirm ? (
                          <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-white px-5 py-2.5 text-sm font-semibold text-rose-600 shadow-sm transition hover:bg-rose-50 hover:shadow active:scale-[0.98]"
                          >
                            <Trash2 className="size-4" />
                            {t("settings.deleteAccountBtn")}
                          </button>
                        ) : (
                          <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="rounded-xl border border-rose-200 bg-rose-50 p-4"
                          >
                            <p className="mb-3 text-sm font-semibold text-rose-800">
                              Are you sure? This action cannot be undone.
                            </p>
                            <div className="flex gap-3">
                              <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-white"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 active:scale-[0.98]"
                              >
                                Yes, Delete My Account
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </div>
                    </section>
                  </motion.div>
                )}

                {activeTab === "notifications" && (
                  <motion.div
                    key="notifications"
                    {...fadeUp}
                    className="space-y-6"
                  >
                    <section className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
                      <div className="border-b border-slate-100 px-6 py-5 sm:px-8">
                        <div className="flex items-center gap-3">
                          <div className="grid size-10 place-items-center rounded-xl bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]">
                            <Bell className="size-5" />
                          </div>
                          <div>
                            <h2 className="text-lg font-bold text-slate-900">{t("settings.notificationPrefs")}</h2>
                            <p className="text-sm text-slate-500">{t("settings.notificationPrefsDesc")}</p>
                          </div>
                        </div>
                      </div>

                      <motion.div
                        variants={staggerContainer}
                        initial="initial"
                        animate="animate"
                        className="divide-y divide-slate-100 p-6 sm:p-8"
                      >
                        {/* Email */}
                        <motion.div
                          variants={staggerItem}
                          className="flex items-start gap-4 py-5 first:pt-0 last:pb-0"
                        >
                          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600">
                            <Mail className="size-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="font-semibold text-slate-900">{t("settings.emailNotifications")}</p>
                                <p className="mt-0.5 text-sm text-slate-500">{t("settings.emailNotificationsDesc")}</p>
                              </div>
                              <ToggleSwitch
                                checked={notifications.email}
                                onChange={() => handleNotificationChange("email")}
                              />
                            </div>
                          </div>
                        </motion.div>

                        {/* SMS */}
                        <motion.div
                          variants={staggerItem}
                          className="flex items-start gap-4 py-5 first:pt-0 last:pb-0"
                        >
                          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600">
                            <Smartphone className="size-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="font-semibold text-slate-900">{t("settings.smsAlerts")}</p>
                                <p className="mt-0.5 text-sm text-slate-500">{t("settings.smsAlertsDesc")}</p>
                              </div>
                              <ToggleSwitch
                                checked={notifications.sms}
                                onChange={() => handleNotificationChange("sms")}
                              />
                            </div>
                          </div>
                        </motion.div>

                        {/* Marketing */}
                        <motion.div
                          variants={staggerItem}
                          className="flex items-start gap-4 py-5 first:pt-0 last:pb-0"
                        >
                          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
                            <Tag className="size-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="font-semibold text-slate-900">{t("settings.marketing")}</p>
                                <p className="mt-0.5 text-sm text-slate-500">{t("settings.marketingDesc")}</p>
                              </div>
                              <ToggleSwitch
                                checked={notifications.marketing}
                                onChange={() => handleNotificationChange("marketing")}
                              />
                            </div>
                          </div>
                        </motion.div>
                      </motion.div>

                      <div className="flex items-center justify-between border-t border-slate-100 px-6 py-5 sm:px-8">
                        <p className="text-sm text-slate-500">
                          {notificationChanges ? t("settings.unsavedChanges") : t("settings.preferencesSaved")}
                        </p>
                        <button
                          onClick={handleNotificationSave}
                          disabled={!notificationChanges}
                          className={`inline-flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-all ${
                            notificationChanges
                              ? "bg-[color:var(--brand-green)] shadow-[color:var(--brand-green)]/20 hover:shadow-md hover:brightness-110 active:scale-[0.98]"
                              : "cursor-not-allowed bg-slate-300"
                          }`}
                        >
                          <Check className="size-4" />
                            {t("settings.savePreferences")}
                        </button>
                      </div>
                    </section>
                  </motion.div>
                )}

                {activeTab === "payment" && (
                  <motion.div
                    key="payment"
                    {...fadeUp}
                    className="space-y-6"
                  >
                    <section className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
                      <div className="border-b border-slate-100 px-6 py-5 sm:px-8">
                        <div className="flex items-center gap-3">
                          <div className="grid size-10 place-items-center rounded-xl bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]">
                            <CreditCard className="size-5" />
                          </div>
                          <div>
                            <h2 className="text-lg font-bold text-slate-900">{t("settings.paymentMethods")}</h2>
                            <p className="text-sm text-slate-500">{t("settings.paymentMethodsDesc")}</p>
                          </div>
                        </div>
                      </div>

                      <div className="p-6 sm:p-8 space-y-4">
                        {/* Saved card — styled like a real card */}
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3 }}
                          className="relative overflow-hidden rounded-2xl bg-slate-900 p-6 text-white shadow-lg sm:p-8"
                        >
                          <div className="absolute right-0 top-0 h-32 w-32 -translate-y-4 translate-x-4 rounded-full bg-white/5" />
                          <div className="absolute bottom-0 left-0 h-24 w-24 -translate-x-6 translate-y-6 rounded-full bg-white/5" />
                          <div className="relative">
                            <div className="flex items-start justify-between">
                              <div className="space-y-1">
                                <p className="text-xs font-medium uppercase tracking-widest text-white/60">Debit Card</p>
                                <p className="text-xl font-bold tracking-widest sm:text-2xl">**** **** **** 4242</p>
                              </div>
                              <div className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white/90 backdrop-blur-sm">
                                Visa
                              </div>
                            </div>
                            <div className="mt-8 flex items-end justify-between">
                              <div>
                                <p className="text-[10px] uppercase tracking-widest text-white/50">Card Holder</p>
                                <p className="mt-0.5 text-sm font-semibold">{user?.name || "User"}</p>
                              </div>
                              <div>
                                <p className="text-[10px] uppercase tracking-widest text-white/50">Expires</p>
                                <p className="mt-0.5 text-sm font-semibold">12 / 25</p>
                              </div>
                            </div>
                          </div>
                        </motion.div>

                        <button className="group flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/50 py-5 text-sm font-semibold text-slate-600 transition hover:border-[color:var(--brand-green)]/40 hover:bg-[color:var(--brand-mist)] hover:text-[color:var(--brand-green)] active:scale-[0.99]">
                          <Plus className="size-4 transition group-hover:scale-110" />
                          {t("settings.addPaymentMethod")}
                        </button>
                      </div>
                    </section>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
