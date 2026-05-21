import { useTranslation } from "react-i18next";
import { ArrowRight, UserCheck, Upload, Wallet } from "lucide-react";

const STEPS = [
  {
    Icon: UserCheck,
    titleKey: "supplier.step1Title",
    descKey: "supplier.step1Desc",
  },
  {
    Icon: Upload,
    titleKey: "supplier.step2Title",
    descKey: "supplier.step2Desc",
  },
  {
    Icon: Wallet,
    titleKey: "supplier.step3Title",
    descKey: "supplier.step3Desc",
  },
];

export function SupplierSection() {
  const { t } = useTranslation();

  return (
    <section className="bg-white py-12 sm:py-16 lg:py-20">
      <div className="mx-auto max-w-[1520px] px-4 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:gap-8">
          {/* Left panel */}
          <div className="relative overflow-hidden rounded-3xl bg-slate-900 px-6 py-10 sm:px-10 sm:py-12 lg:px-12 lg:py-16">
            {/* Decorative circle */}
            <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-slate-800/60 sm:size-80" />

            <div className="relative z-10 max-w-lg">
              <span className="mb-5 inline-block rounded-full border border-slate-700 bg-slate-800/60 px-4 py-1.5 text-xs font-semibold tracking-wide text-emerald-400 sm:text-sm">
                {t("supplier.badge", "For suppliers and experience hosts")}
              </span>

              <h2
                className="mt-3 font-bold leading-[1.1] tracking-tight text-white"
                style={{ fontSize: "clamp(1.875rem, 2.5vw + 0.5rem, 2.75rem)" }}
              >
                {t(
                  "supplier.heading",
                  "Sell your tours to travellers across Africa."
                )}
              </h2>

              <p className="mt-5 max-w-md text-sm leading-relaxed text-slate-300 sm:text-base">
                {t(
                  "supplier.body",
                  "Join Expedition GO Tours as a verified partner, manage your listings, receive bookings, setup your payment method and grow your tour business with a modern OTA platform."
                )}
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3 sm:gap-4">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full bg-amber-400 px-5 py-3 text-sm font-bold text-slate-900 shadow-lg transition hover:bg-amber-300 hover:shadow-xl active:scale-[0.98]"
                >
                  {t("supplier.ctaPrimary", "Become a supplier")}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full border border-slate-600 bg-transparent px-5 py-3 text-sm font-semibold text-white transition hover:border-slate-400 hover:bg-slate-800 active:scale-[0.98]"
                >
                  {t("supplier.ctaSecondary", "Learn how it works")}
                  <ArrowRight className="size-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Right panel */}
          <div className="flex flex-col justify-center gap-4 rounded-3xl bg-amber-50/50 px-6 py-8 sm:px-10 sm:py-10 lg:px-12 lg:py-12">
            {STEPS.map(({ Icon, titleKey, descKey }, idx) => (
              <div
                key={titleKey}
                className="flex items-center gap-4 rounded-2xl border border-slate-100 bg-white px-5 py-5 shadow-sm transition hover:shadow-md sm:gap-5 sm:px-6 sm:py-6"
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-emerald-800 text-sm font-bold text-white sm:size-11">
                  {idx + 1}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900 sm:text-base">
                    {t(titleKey)}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500 sm:text-sm">
                    {t(descKey)}
                  </p>
                </div>
                <Icon className="ml-auto hidden size-6 shrink-0 text-slate-300 sm:block sm:size-7" strokeWidth={1.5} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
