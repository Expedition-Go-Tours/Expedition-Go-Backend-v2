import { CheckCircle, CreditCard, Star, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

const WHY_BOOK_ITEMS = [
  {
    Icon: CheckCircle,
    titleKey: "whyBookVerifiedTitle",
    descKey: "whyBookVerifiedDesc",
  },
  {
    Icon: CreditCard,
    titleKey: "whyBookPaymentsTitle",
    descKey: "whyBookPaymentsDesc",
  },
  {
    Icon: Star,
    titleKey: "whyBookReviewsTitle",
    descKey: "whyBookReviewsDesc",
  },
  {
    Icon: MessageCircle,
    titleKey: "whyBookSupportTitle",
    descKey: "whyBookSupportDesc",
  },
];

export function FeaturesSection() {
  const { t } = useTranslation();

  return (
    <section className="relative overflow-hidden bg-white py-16 sm:py-20 lg:py-24">
      <div className="relative mx-auto max-w-[1520px] px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-10 text-center sm:mb-12 lg:mb-14">
          <h5
            className="font-semibold tracking-tight text-slate-900"
            style={{ fontSize: "clamp(1.75rem, 3vw + 0.5rem, 2.5rem)" }}
          >
            {t("features.whyBookHeading")}
         </h5>
        </div>

        {/* Cards grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
          {WHY_BOOK_ITEMS.map(({ Icon, titleKey, descKey }) => (
            <div
              key={titleKey}
              className="rounded-2xl border border-slate-200 bg-slate-50/50 p-5 transition hover:border-emerald-200 hover:bg-emerald-50/30 sm:p-6"
            >
              <div className="mx-auto grid size-14 place-items-center rounded-xl bg-[color:var(--brand-mist)]">
                <Icon
                  className="size-7 text-[color:var(--brand-green)]"
                  strokeWidth={1.8}
                  aria-hidden
                />
              </div>
              <h5 className="mt-4 text-center text-[10px] font-bold text-slate-900 sm:text-lg">
                {t(`features.${titleKey}`)}
              </h5>
              <p className="mt-2 text-center text-sm leading-relaxed text-slate-600">
                {t(`features.${descKey}`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
