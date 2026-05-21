import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";
import { hideTawkWidget, loadTawkScript, openTawkChat } from "@/lib/tawk";

export default function SupportPage() {
  const { t } = useTranslation();
  useEffect(() => {
    loadTawkScript();
    return () => hideTawkWidget();
  }, []);

  return (
    <div className="flex flex-col min-h-screen">
      <div className="bg-white">
        <Navbar />
      </div>
      
      {/* Navbar spacer */}
      <div className="h-[58px] sm:h-[96px] lg:h-[104px]" />

      <main className="flex-1 bg-white">
        <div className="mx-auto max-w-[1520px] px-4 py-12 sm:px-6 lg:px-8">
          <div className="mb-12">
            <h1 className="font-bold tracking-tight text-slate-900 mb-4" style={{ fontSize: 'clamp(1.75rem, 3vw + 0.5rem, 2.75rem)' }}>{t("support.title")}</h1>
            <p className="text-slate-600" style={{ fontSize: 'clamp(1rem, 1.2vw + 0.5rem, 1.25rem)' }}>
              {t("support.subtitle")}
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
            {/* FAQ Section */}
            <div className="rounded-lg border border-slate-200 p-6">
              <h2 className="font-bold text-slate-900 mb-4" style={{ fontSize: 'clamp(1.125rem, 1.5vw + 0.5rem, 1.5rem)' }}>{t("support.faqTitle")}</h2>
              <ul className="space-y-3 text-slate-700">
                <li className="flex items-start gap-2">
                  <span className="text-[color:var(--brand-green)] font-bold">•</span>
                  <span>{t("support.faq1")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[color:var(--brand-green)] font-bold">•</span>
                  <span>{t("support.faq2")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[color:var(--brand-green)] font-bold">•</span>
                  <span>{t("support.faq3")}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[color:var(--brand-green)] font-bold">•</span>
                  <span>{t("support.faq4")}</span>
                </li>
              </ul>
            </div>

            {/* Contact Information */}
            <div className="rounded-lg border border-slate-200 p-6">
              <h2 className="font-bold text-slate-900 mb-4" style={{ fontSize: 'clamp(1.125rem, 1.5vw + 0.5rem, 1.5rem)' }}>{t("support.contactTitle")}</h2>
              <div className="space-y-4 text-slate-700">
                <div>
                  <p className="font-semibold text-slate-900">{t("support.emailLabel")}</p>
                  <p>support@expeditiongo.com</p>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{t("support.phoneLabel")}</p>
                  <p>+1 (555) 123-4567</p>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{t("support.hoursLabel")}</p>
                  <p>{t("support.hoursValue")}</p>
                </div>
              </div>
            </div>

            {/* Live Chat */}
            <div className="rounded-lg border border-slate-200 p-6 bg-[color:var(--brand-mist)]">
              <h2 className="font-bold text-slate-900 mb-4" style={{ fontSize: 'clamp(1.125rem, 1.5vw + 0.5rem, 1.5rem)' }}>{t("support.chatTitle")}</h2>
              <p className="text-slate-700 mb-4">
                {t("support.chatDesc")}
              </p>
              <button
                type="button"
                onClick={() => openTawkChat()}
                className="w-full rounded-lg bg-[color:var(--brand-green)] px-4 py-2 font-semibold text-white transition hover:bg-[color:var(--brand-green)]/90"
              >
                {t("support.chatButton")}
              </button>
            </div>
          </div>

          {/* Help Topics */}
          <div className="mt-12">
            <h2 className="font-bold text-slate-900 mb-6" style={{ fontSize: 'clamp(1.375rem, 2vw + 0.5rem, 1.875rem)' }}>{t("support.helpTopicsTitle")}</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-4 hover:border-[color:var(--brand-green)] transition cursor-pointer">
                <h3 className="text-base font-semibold text-slate-900">{t("support.topic1Title")}</h3>
                <p className="text-sm text-slate-600 mt-1">{t("support.topic1Desc")}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 hover:border-[color:var(--brand-green)] transition cursor-pointer">
                <h3 className="text-base font-semibold text-slate-900">{t("support.topic2Title")}</h3>
                <p className="text-sm text-slate-600 mt-1">{t("support.topic2Desc")}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 hover:border-[color:var(--brand-green)] transition cursor-pointer">
                <h3 className="text-base font-semibold text-slate-900">{t("support.topic3Title")}</h3>
                <p className="text-sm text-slate-600 mt-1">{t("support.topic3Desc")}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 hover:border-[color:var(--brand-green)] transition cursor-pointer">
                <h3 className="text-base font-semibold text-slate-900">{t("support.topic4Title")}</h3>
                <p className="text-sm text-slate-600 mt-1">{t("support.topic4Desc")}</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
