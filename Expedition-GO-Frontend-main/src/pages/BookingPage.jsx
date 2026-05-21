import { useState, useMemo, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  ChevronRight,
  HelpCircle,
  X,
  MapPin,
  CalendarDays,
  Users,
  Phone,
  MessageSquare,
  Globe,
  ShieldCheck,
  Clock,
  CreditCard,
  Info,
  ArrowLeft,
  Star,
} from "lucide-react";
import { Navbar } from "@/components/homepage/Navbar";
import { Footer } from "@/components/homepage/Footer";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const COUNTRY_CODES = [
  { label: "Ghana (+233)", value: "+233" },
  { label: "United States (+1)", value: "+1" },
  { label: "United Kingdom (+44)", value: "+44" },
  { label: "Nigeria (+234)", value: "+234" },
  { label: "South Africa (+27)", value: "+27" },
  { label: "Germany (+49)", value: "+49" },
  { label: "France (+33)", value: "+33" },
  { label: "Canada (+1)", value: "+1" },
];

const PAYMENT_METHODS = [
  {
    id: "card",
    label: "Credit / Debit Card",
    logos: ["Mastercard", "Amex", "JCB", "Discover", "Visa"],
  },
  { id: "paypal", label: "PayPal" },
  { id: "googlepay", label: "Google Pay" },
];

/* ------------------------------------------------------------------ */
/*  Demo fallback data (used when no location state is passed)         */
/* ------------------------------------------------------------------ */
const DEMO_TOUR = {
  title: "Experience the Beauty, History and the Culture Of Accra in a Day",
  image:
    "https://images.unsplash.com/photo-1601758125946-6ec2ef64daf8?auto=format&fit=crop&w=600&q=80",
  provider: "Expedition GO Tours",
  rating: 4.9,
  reviews: 248,
  date: "Tuesday, June 2, 2026",
  time: "9:00 AM",
  duration: "6h",
  travelers: "1 adult",
  price: 80.0,
  cancellation: "Free cancellation before 9:00 AM on June 1 (tour local time)",
  language: "English - Guide",
};

/* ------------------------------------------------------------------ */
/*  Mobile summary card (shows on small screens only)                  */
/* ------------------------------------------------------------------ */
function MobileSummaryCard({ tour, onChangeClick }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100">
          <img
            src={tour.image}
            alt={tour.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold leading-tight text-slate-900 line-clamp-2">
            {tour.title}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {tour.date} &bull; {tour.time}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">{tour.travelers}</p>
        </div>
        <button
          onClick={onChangeClick}
          className="shrink-0 text-xs font-semibold text-[color:var(--brand-green)] underline underline-offset-2"
        >
          {t("booking.change")}
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
        <span className="text-sm font-semibold text-slate-900">{t("booking.total")}</span>
        <span className="text-lg font-bold text-slate-900">
          ${tour.price.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step indicator                                                     */
/* ------------------------------------------------------------------ */
function StepIndicator({ steps, currentStep }) {
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      {steps.map((step, i) => {
        const isActive = i + 1 === currentStep;
        const isCompleted = i + 1 < currentStep;
        const num = i + 1;
        return (
          <div key={step} className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <div
                className={`grid size-7 sm:size-8 place-items-center rounded-full text-xs sm:text-sm font-bold transition-colors ${
                  isCompleted
                    ? "bg-[color:var(--brand-green)] text-white"
                    : isActive
                      ? "bg-[color:var(--brand-green)] text-white"
                      : "border-2 border-slate-300 text-slate-400"
                }`}
              >
                {isCompleted ? <Check className="size-3.5 sm:size-4" /> : num}
              </div>
              <span
                className={`hidden sm:inline text-sm font-semibold ${
                  isActive || isCompleted
                    ? "text-slate-900"
                    : "text-slate-400"
                }`}
              >
                {step}
              </span>
            </div>
            {i < steps.length - 1 && (
              <ChevronRight className="size-3.5 sm:size-4 text-slate-300" />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Form field wrappers                                                */
/* ------------------------------------------------------------------ */
function FieldLabel({ children, required, hint }) {
  return (
    <label className="mb-1.5 flex items-center gap-1 text-sm font-semibold text-slate-700">
      {children}
      {required && <span className="text-rose-500">*</span>}
      {hint && (
        <button type="button" className="text-slate-400 hover:text-slate-600">
          <HelpCircle className="size-3.5" />
        </button>
      )}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  valid = false,
  disabled = false,
}) {
  return (
    <div className="relative">
      <input
        type={type}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        className={`w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:ring-2 ${
          valid
            ? "border-emerald-300 focus:border-emerald-400 focus:ring-emerald-100"
            : "border-slate-200 focus:border-[color:var(--brand-green)] focus:ring-[color:var(--brand-green)]/15"
        } ${disabled ? "cursor-not-allowed bg-slate-50 text-slate-400" : ""}`}
      />
      {valid && (
        <Check className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-emerald-500" />
      )}
    </div>
  );
}

function SelectInput({ value, onChange, options }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={onChange}
        className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-4 py-3 pr-10 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/15"
      >
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
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */
function BookingSidebar({ tour, promoCode, setPromoCode, onApplyPromo, onChangeClick }) {
  const { t } = useTranslation();
  const stars = useMemo(() => {
    const full = Math.floor(tour.rating);
    return Array.from({ length: 5 }, (_, i) => i < full);
  }, [tour.rating]);

  return (
    <div className="space-y-4">
      {/* Tour summary card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
        <div className="flex gap-3 p-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-slate-100">
            <img
              src={tour.image}
              alt={tour.title}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold leading-tight text-slate-900 line-clamp-2">
              {tour.title}
            </h3>
            <div className="mt-1 flex items-center gap-1">
              <span className="text-sm font-bold text-slate-900">
                {tour.rating}
              </span>
              <div className="flex items-center gap-0.5">
                {stars.map((filled, i) => (
                  <Star
                    key={i}
                    className={`size-3 ${filled ? "fill-[color:var(--brand-green)] text-[color:var(--brand-green)]" : "text-slate-200"}`}
                  />
                ))}
              </div>
              <span className="text-xs text-slate-500">({tour.reviews})</span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              By <span className="font-semibold text-slate-700">{tour.provider}</span>
            </p>
          </div>
        </div>

        <div className="border-t border-slate-100 px-4 py-3 space-y-2">
          <div className="flex items-start gap-2 text-xs text-slate-600">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
            <span className="line-clamp-2">{tour.title}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <CalendarDays className="size-3.5 shrink-0 text-slate-400" />
            <span>
              {tour.date} &bull; {tour.time}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <Users className="size-3.5 shrink-0 text-slate-400" />
            <span>{tour.travelers}</span>
          </div>
        </div>

        <div className="border-t border-slate-100 px-4 py-3">
          <button
            onClick={onChangeClick}
            className="text-sm font-semibold text-[color:var(--brand-green)] underline underline-offset-2 hover:opacity-85"
          >
            {t("booking.change")}
          </button>
        </div>

        <div className="border-t border-slate-100 px-4 py-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[color:var(--brand-green)]" />
            <p className="text-xs text-slate-600">{tour.cancellation}</p>
          </div>
        </div>
      </div>

      {/* Promo code */}
      <div className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-slate-900">{t("booking.promoCode")}</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            placeholder="Enter promo code"
            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/15"
          />
          <button
            onClick={onApplyPromo}
            className="rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)]"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Total */}
      <div className="flex items-center justify-between rounded-2xl border border-slate-200/60 bg-white p-4 shadow-sm">
        <span className="text-sm font-semibold text-slate-900">{t("booking.total")}</span>
        <span className="text-lg font-bold text-slate-900">
          ${tour.price.toFixed(2)}
        </span>
      </div>

      {/* Support */}
      <div className="rounded-2xl border border-slate-200/60 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-slate-900">{t("booking.supportTitle")}</p>
        <div className="mt-2 flex items-center gap-4 text-sm">
          <a
            href="tel:+18337642166"
            className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-[color:var(--brand-green)]"
          >
            <Phone className="size-4" />
            +1 833 764 2166
          </a>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 font-medium text-slate-700 hover:text-[color:var(--brand-green)]"
          >
            <MessageSquare className="size-4" />
            Chat now
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 1 – Contact details                                           */
/* ------------------------------------------------------------------ */
function ContactDetailsStep({ data, onChange, onNext, valid }) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-6 py-5 sm:px-8">
        <h2 className="text-lg font-bold text-slate-900">{t("booking.contactTitle")}</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          {t("booking.contactDesc")}
        </p>
      </div>

      <div className="space-y-5 p-6 sm:p-8">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <FieldLabel required>First Name</FieldLabel>
            <TextInput
              value={data.firstName}
              onChange={(e) => onChange("firstName", e.target.value)}
              placeholder="e.g. Richard"
              valid={valid.firstName}
            />
          </div>
          <div>
            <FieldLabel required>Last Name</FieldLabel>
            <TextInput
              value={data.lastName}
              onChange={(e) => onChange("lastName", e.target.value)}
              placeholder="e.g. Boochie"
              valid={valid.lastName}
            />
          </div>
        </div>

        <div>
          <FieldLabel required hint>
            Email
          </FieldLabel>
          <TextInput
            type="email"
            value={data.email}
            onChange={(e) => onChange("email", e.target.value)}
            placeholder=""
            valid={valid.email}
          />
        </div>

        <div>
          <FieldLabel required hint>
            Phone Number
          </FieldLabel>
          <div className="grid gap-3 sm:grid-cols-[1.2fr_2fr]">
            <SelectInput
              value={data.countryCode}
              onChange={(e) => onChange("countryCode", e.target.value)}
              options={COUNTRY_CODES}
            />
            <TextInput
              type="tel"
              value={data.phone}
              onChange={(e) => onChange("phone", e.target.value)}
              placeholder=""
              valid={valid.phone}
            />
          </div>
        </div>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={data.smsUpdates}
            onChange={(e) => onChange("smsUpdates", e.target.checked)}
            className="mt-0.5 size-4 rounded border-slate-300 text-[color:var(--brand-green)] focus:ring-[color:var(--brand-green)]"
          />
          <span className="text-sm text-slate-600">
            {t("booking.smsUpdatesLabel")}
          </span>
        </label>

        <div className="flex justify-end pt-2">
          <button
            onClick={onNext}
            disabled={!valid.all}
            className={`inline-flex items-center gap-2 rounded-full px-7 py-3 text-sm font-semibold shadow-sm transition active:scale-[0.98] ${
              valid.all
                ? "bg-[color:var(--brand-green)] text-white hover:brightness-110"
                : "cursor-not-allowed bg-slate-300 text-white"
            }`}
          >
            {t("booking.next")}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 2 – Activity details                                          */
/* ------------------------------------------------------------------ */
function ActivityDetailsStep({ data, onChange, tour, onNext, valid }) {
  const { t } = useTranslation();
  const [pickupQuery, setPickupQuery] = useState(data.pickupLocation);

  const pickupLocations = useMemo(
    () => ["Accra", "Labadi", "Osu", "Airport City", "East Legon"],
    []
  );
  const filteredPickup = useMemo(() => {
    if (!pickupQuery) return [];
    return pickupLocations.filter((l) =>
      l.toLowerCase().includes(pickupQuery.toLowerCase())
    );
  }, [pickupQuery, pickupLocations]);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-6 py-5 sm:px-8">
        <h2 className="text-lg font-bold text-slate-900">{t("booking.activityTitle")}</h2>
      </div>

      <div className="space-y-5 p-6 sm:p-8">
        {/* Tour summary */}
        <div className="flex gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100">
            <img
              src={tour.image}
              alt={tour.title}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[color:var(--brand-green)]" />
              <p className="text-xs font-medium text-[color:var(--brand-green)]">
                {tour.cancellation}
              </p>
            </div>
            <h3 className="mt-1 text-sm font-bold text-slate-900 line-clamp-2">
              {tour.title}
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">
              {tour.title}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {tour.date} &bull; {tour.time}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{tour.travelers}</p>
          </div>
        </div>

        {/* Lead traveler */}
        <div>
          <p className="mb-3 text-sm font-semibold text-slate-900">
            {t("booking.leadTraveler")}
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <FieldLabel required>First Name</FieldLabel>
              <TextInput
                value={data.leadFirstName}
                onChange={(e) => onChange("leadFirstName", e.target.value)}
              placeholder=""
                valid={valid.leadFirstName}
              />
            </div>
            <div>
              <FieldLabel required>Last Name</FieldLabel>
              <TextInput
                value={data.leadLastName}
                onChange={(e) => onChange("leadLastName", e.target.value)}
              placeholder=""
                valid={valid.leadLastName}
              />
            </div>
          </div>
        </div>

        {/* Pickup location */}
        <div className="relative">
          <FieldLabel required>{t("booking.pickupLocation")}</FieldLabel>
          <p className="mb-2 text-xs text-slate-500">
            {t("booking.pickupLocationDesc")}
          </p>
          <div className="relative">
            <input
              type="text"
              value={pickupQuery}
              onChange={(e) => {
                setPickupQuery(e.target.value);
                onChange("pickupLocation", e.target.value);
              }}
              placeholder=""
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 pr-10 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/15"
            />
            {pickupQuery && (
              <button
                type="button"
                onClick={() => {
                  setPickupQuery("");
                  onChange("pickupLocation", "");
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {filteredPickup.length > 0 && pickupQuery && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
              {filteredPickup.map((loc) => (
                <button
                  key={loc}
                  type="button"
                  onClick={() => {
                    setPickupQuery(loc);
                    onChange("pickupLocation", loc);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  <MapPin className="size-3.5 text-slate-400" />
                  {loc}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Tour language */}
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">
            {t("booking.tourLanguage")}
          </span>
          <span className="text-sm text-slate-600">
            {tour.language}
          </span>
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={onNext}
            disabled={!valid.all}
            className={`inline-flex items-center gap-2 rounded-full px-7 py-3 text-sm font-semibold shadow-sm transition active:scale-[0.98] ${
              valid.all
                ? "bg-[color:var(--brand-green)] text-white hover:brightness-110"
                : "cursor-not-allowed bg-slate-300 text-white"
            }`}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 3 – Payment details                                           */
/* ------------------------------------------------------------------ */
function PaymentDetailsStep({
  data,
  onChange,
  tour,
  onBook,
}) {
  const { t } = useTranslation();
  const [cardForm, setCardForm] = useState({
    name: "",
    number: "",
    expiryMonth: "",
    expiryYear: "",
    cvc: "",
    country: "United States",
    postal: "",
    save: false,
  });

  useEffect(() => {
    if (
      data.paymentTiming === "later" &&
      !["card", "paypal"].includes(data.paymentMethod)
    ) {
      onChange("paymentMethod", "card");
    }
  }, [data.paymentTiming, data.paymentMethod, onChange]);

  const countries = [
    "United States",
    "United Kingdom",
    "Canada",
    "Ghana",
    "Nigeria",
    "Germany",
    "France",
    "Netherlands",
    "Spain",
  ];

  const handleCardChange = (key, value) =>
    setCardForm((prev) => ({ ...prev, [key]: value }));

  const buttonLabel =
    data.paymentMethod === "paypal"
      ? "PayPal"
      : data.paymentMethod === "googlepay"
        ? "Buy with Google Pay"
        : t("booking.bookNow");

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-6 py-5 sm:px-8">
        <h2 className="text-lg font-bold text-slate-900">{t("booking.paymentTitle")}</h2>
      </div>

      <div className="space-y-6 p-6 sm:p-8">
        {/* Choose when to pay */}
        <div>
          <p className="mb-3 text-sm font-semibold text-slate-900">
            {t("booking.chooseWhenToPay")}
          </p>
          <div className="space-y-2">
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition ${
                data.paymentTiming === "now"
                  ? "border-emerald-300"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div
                className={`grid size-5 shrink-0 place-items-center rounded-full border-2 ${
                  data.paymentTiming === "now"
                    ? "border-emerald-400"
                    : "border-slate-300"
                }`}
              >
                {data.paymentTiming === "now" && (
                  <div className="size-2.5 rounded-full bg-emerald-500" />
                )}
              </div>
              <span className="min-w-0 flex-1 text-sm font-semibold text-slate-900">
                {t("booking.payNow")}
              </span>
              <span className="shrink-0 text-sm font-bold text-slate-900">
                ${tour.price.toFixed(2)}
              </span>
              <input
                type="radio"
                name="paymentTiming"
                className="sr-only"
                checked={data.paymentTiming === "now"}
                onChange={() => onChange("paymentTiming", "now")}
              />
            </label>

            <label
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition sm:items-center ${
                data.paymentTiming === "later"
                  ? "border-emerald-300"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div
                className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 sm:mt-0 ${
                  data.paymentTiming === "later"
                    ? "border-emerald-400"
                    : "border-slate-300"
                }`}
              >
                {data.paymentTiming === "later" && (
                  <div className="size-2.5 rounded-full bg-emerald-500" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-slate-900">
                  {t("booking.reserveLater")}
                </span>
                <p className="text-xs text-slate-500">
                  {t("booking.reserveLaterDesc", { price: tour.price.toFixed(2) })}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <span className="text-sm font-bold text-slate-900">$0.00</span>
                <p className="text-[10px] text-slate-400">now</p>
              </div>
              <input
                type="radio"
                name="paymentTiming"
                className="sr-only"
                checked={data.paymentTiming === "later"}
                onChange={() => onChange("paymentTiming", "later")}
              />
            </label>
          </div>
        </div>

        {/* Pay with */}
        <div>
          <p className="mb-3 text-sm font-semibold text-slate-900">{t("booking.payWith")}</p>
          <div className="space-y-2">
            {PAYMENT_METHODS
              .filter((method) =>
                data.paymentTiming === "later"
                  ? ["card", "paypal"].includes(method.id)
                  : true
              )
              .map((method) => (
                <label
                  key={method.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition ${
                    data.paymentMethod === method.id
                      ? "border-emerald-300"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div
                    className={`grid size-5 place-items-center rounded-full border-2 ${
                      data.paymentMethod === method.id
                        ? "border-emerald-400"
                        : "border-slate-300"
                    }`}
                  >
                    {data.paymentMethod === method.id && (
                      <div className="size-2.5 rounded-full bg-emerald-500" />
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1.5">
                    <span className="text-sm font-semibold text-slate-900">
                      {method.label}
                    </span>
                    {method.logos && (
                      <div className="flex flex-wrap items-center gap-1">
                        {method.logos.map((logo) => (
                          <span
                            key={logo}
                            className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-slate-500 sm:px-1.5 sm:text-[9px]"
                          >
                            {logo}
                          </span>
                        ))}
                      </div>
                    )}
                    {method.sub && (
                      <span className="text-xs text-slate-500">{method.sub}</span>
                    )}
                  </div>
                  <input
                    type="radio"
                    name="paymentMethod"
                    className="sr-only"
                    checked={data.paymentMethod === method.id}
                    onChange={() => onChange("paymentMethod", method.id)}
                  />
                </label>
              ))}
          </div>
        </div>

        {/* Credit card form */}
        {data.paymentMethod === "card" && (
          <div className="space-y-4 rounded-xl border border-slate-100 bg-white p-5 sm:p-6">
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-slate-700">
                Cardholder Name
              </label>
              <input
                type="text"
                value={cardForm.name}
                onChange={(e) => handleCardChange("name", e.target.value)}
                placeholder=""
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-semibold text-slate-700">
                Credit Card Number
              </label>
              <input
                type="text"
                value={cardForm.number}
                onChange={(e) => handleCardChange("number", e.target.value)}
                placeholder=""
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Expiration Date
                </label>
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <input
                    type="text"
                    value={cardForm.expiryMonth}
                    onChange={(e) => handleCardChange("expiryMonth", e.target.value)}
                    placeholder="MM"
                    maxLength={2}
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2 py-3 text-center text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 sm:px-4"
                  />
                  <span className="shrink-0 text-slate-400">/</span>
                  <input
                    type="text"
                    value={cardForm.expiryYear}
                    onChange={(e) => handleCardChange("expiryYear", e.target.value)}
                    placeholder="YY"
                    maxLength={2}
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2 py-3 text-center text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 sm:px-4"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Security Code
                </label>
                <input
                  type="text"
                  value={cardForm.cvc}
                  onChange={(e) => handleCardChange("cvc", e.target.value)}
                  placeholder=""
                  maxLength={4}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                />
                <button
                  type="button"
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:text-sky-700"
                >
                  <HelpCircle className="size-3" />
                  What is this?
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Country
                </label>
                <div className="relative">
                  <select
                    value={cardForm.country}
                    onChange={(e) => handleCardChange("country", e.target.value)}
                    className="w-full appearance-none rounded-xl border border-slate-200 bg-white px-4 py-3 pr-10 text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    {countries.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <ChevronRight className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 rotate-90 text-slate-400" />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Postal/Zip Code <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={cardForm.postal}
                  onChange={(e) => handleCardChange("postal", e.target.value)}
                  placeholder=""
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                />
              </div>
            </div>

            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={cardForm.save}
                onChange={(e) => handleCardChange("save", e.target.checked)}
                className="mt-0.5 size-4 rounded border-slate-300 text-[color:var(--brand-green)] focus:ring-[color:var(--brand-green)]"
              />
              <span className="text-sm text-slate-600">
                Add this card to your account for future use{" "}
                <HelpCircle className="inline size-3.5 text-slate-400" />
              </span>
            </label>
          </div>
        )}

        {/* Total */}
        <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-5 text-center">
          <p className="text-xl font-bold text-slate-900">
            {t("booking.totalPrice", { price: tour.price.toFixed(2) })}
          </p>
          <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-slate-600">
            <ShieldCheck className="size-3.5 text-[color:var(--brand-green)]" />
            {tour.cancellation}
          </div>
        </div>

        {/* Terms */}
        <p className="text-xs leading-relaxed text-slate-500">
          By clicking &quot;{buttonLabel}&quot;, you agree to our{" "}
          <a href="#" className="font-semibold underline hover:text-slate-700">
            Terms
          </a>{" "}
          &amp;{" "}
          <a href="#" className="font-semibold underline hover:text-slate-700">
            Privacy and Cookies Statement
          </a>
          , plus the tour operator&apos;s rules &amp; regulations.
        </p>

        {/* Book now */}
        <button
          onClick={onBook}
          className="w-full rounded-full bg-[color:var(--brand-green)] py-3.5 text-sm font-bold text-white shadow-sm transition hover:brightness-110 active:scale-[0.98]"
        >
          {buttonLabel}
        </button>

        <p className="text-[11px] leading-relaxed text-slate-400">
          Your booking is facilitated by our platform, but a third-party tour
          operator provides the tour/activity directly to you. By clicking
          &quot;Book Now&quot;, you consent to receive special offers, tips and
          other updates from us, from which you can unsubscribe at any time.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Change Booking Modal                                               */
/* ------------------------------------------------------------------ */
function ChangeBookingModal({ tour, isOpen, onClose, onReserve }) {
  const { t } = useTranslation();
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  });
  const [travelers, setTravelers] = useState(1);
  const [selectedTime, setSelectedTime] = useState(tour.time || "9:00 AM");

  const timeSlots = ["8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:00 PM", "2:00 PM"];

  const formattedDate = useMemo(() => {
    const d = new Date(selectedDate);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }, [selectedDate]);

  const total = tour.price * travelers;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        transition={{ duration: 0.2 }}
        className="relative z-10 flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900 leading-tight">
              {tour.title}
            </h2>
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
                <CalendarDays className="size-3.5 text-slate-500" />
                {formattedDate}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
                <Users className="size-3.5 text-slate-500" />
                {travelers}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Info pills */}
          <div className="space-y-3 rounded-xl bg-slate-50/70 p-4">
            <div className="flex items-start gap-2.5 text-xs text-slate-600">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[color:var(--brand-green)]" />
              <span>
                <span className="font-semibold text-slate-800 underline underline-offset-2 cursor-pointer">{t("booking.cancellationPolicy")}</span>
                {" "}&bull; {t("booking.cancellationPolicyDesc")}
              </span>
            </div>
            <div className="flex items-start gap-2.5 text-xs text-slate-600">
              <CreditCard className="mt-0.5 size-4 shrink-0 text-[color:var(--brand-green)]" />
              <span>
                <span className="font-semibold text-slate-800 underline underline-offset-2 cursor-pointer">{t("booking.reserveNowPayLater")}</span>
                {" "}&bull; {t("booking.reserveNowPayLaterDesc")}
              </span>
            </div>
            <div className="flex items-start gap-2.5 text-xs text-slate-600">
              <Info className="mt-0.5 size-4 shrink-0 text-[color:var(--brand-green)]" />
              <span>
                <span className="font-semibold text-slate-800">{t("booking.bookAhead")}</span>
                {" "}&bull; {t("booking.bookAheadDesc")}
              </span>
            </div>
          </div>

          {/* Option card */}
          <div className="rounded-xl border-2 border-[color:var(--brand-green)] bg-white p-4">
            <h3 className="text-sm font-bold text-slate-900">{tour.title}</h3>
            <p className="mt-1 text-xs text-slate-500">{t("booking.pickupIncluded")}</p>
            <div className="mt-3 space-y-1">
              <p className="text-xs text-slate-600">
                {travelers} Adult x ${tour.price.toFixed(2)}
              </p>
              <p className="text-sm font-bold text-slate-900">
                Total ${total.toFixed(2)}
              </p>
              <p className="text-[11px] text-slate-400">
                {t("booking.priceIncludesFees")}
              </p>
            </div>

            {/* Time selector */}
            <div className="mt-4 flex flex-wrap gap-2">
              {timeSlots.map((time) => (
                <button
                  key={time}
                  onClick={() => setSelectedTime(time)}
                  className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition ${
                    selectedTime === time
                      ? "border-[color:var(--brand-green)] bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  }`}
                >
                  {time}
                </button>
              ))}
            </div>
          </div>

          {/* Date picker */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              {t("booking.selectDate")}
            </label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-[color:var(--brand-green)] focus:ring-2 focus:ring-[color:var(--brand-green)]/15"
            />
          </div>

          {/* Travelers */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              {t("booking.travelers")}
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setTravelers((t) => Math.max(1, t - 1))}
                className="grid size-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300"
              >
                −
              </button>
              <span className="min-w-[2rem] text-center text-lg font-bold text-slate-900">
                {travelers}
              </span>
              <button
                onClick={() => setTravelers((t) => Math.min(20, t + 1))}
                className="grid size-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300"
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-100 px-6 py-4">
          <button
            onClick={() => {
              onReserve({
                date: formattedDate,
                time: selectedTime,
                travelers: `${travelers} ${travelers === 1 ? "adult" : "adults"}`,
                price: tour.price,
              });
              onClose();
            }}
            className="w-full rounded-full bg-[color:var(--brand-green)] py-3.5 text-sm font-bold text-white shadow-sm transition hover:brightness-110 active:scale-[0.98]"
          >
            {t("booking.reserveNow")}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */
export default function BookingPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  /* Tour data from navigation state, fallback to demo */
  const tour = location.state?.tour || DEMO_TOUR;

  const [step, setStep] = useState(1);
  const [promoCode, setPromoCode] = useState("");
  const [discount, setDiscount] = useState(0);

  const [contact, setContact] = useState({
    firstName: "",
    lastName: "",
    email: "",
    countryCode: "+233",
    phone: "",
    smsUpdates: false,
  });

  const [activity, setActivity] = useState({
    leadFirstName: "",
    leadLastName: "",
    pickupLocation: "",
  });

  const [payment, setPayment] = useState({
    paymentTiming: "now",
    paymentMethod: "card",
  });

  /* Change booking modal state */
  const [isChangeModalOpen, setIsChangeModalOpen] = useState(false);
  const [editableTour, setEditableTour] = useState({
    date: tour.date,
    time: tour.time,
    travelers: tour.travelers,
    price: tour.price,
  });

  /* Validation helpers */
  const contactValid = useMemo(
    () => ({
      firstName: contact.firstName.trim().length > 1,
      lastName: contact.lastName.trim().length > 1,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email),
      phone: contact.phone.trim().length >= 7,
      all:
        contact.firstName.trim().length > 1 &&
        contact.lastName.trim().length > 1 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) &&
        contact.phone.trim().length >= 7,
    }),
    [contact]
  );

  const activityValid = useMemo(
    () => ({
      leadFirstName: activity.leadFirstName.trim().length > 1,
      leadLastName: activity.leadLastName.trim().length > 1,
      pickupLocation: activity.pickupLocation.trim().length > 0,
      all:
        activity.leadFirstName.trim().length > 1 &&
        activity.leadLastName.trim().length > 1 &&
        activity.pickupLocation.trim().length > 0,
    }),
    [activity]
  );

  const handleContactChange = (key, value) =>
    setContact((prev) => ({ ...prev, [key]: value }));
  const handleActivityChange = (key, value) =>
    setActivity((prev) => ({ ...prev, [key]: value }));
  const handlePaymentChange = (key, value) =>
    setPayment((prev) => ({ ...prev, [key]: value }));

  const handleNext = (nextStep) => setStep(nextStep);

  const handleBook = () => {
    // Booking action placeholder — no-op for now
  };

  const handleApplyPromo = () => {
    if (promoCode.trim().toLowerCase() === "save10") {
      setDiscount(editableTour.price * 0.1);
    } else {
      setDiscount(0);
    }
  };

  const finalPrice = editableTour.price - discount;
  const activeTour = { ...tour, ...editableTour, price: finalPrice };

  const steps = [t("booking.step1"), t("booking.step2"), t("booking.step3")];

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Navbar />
      <div className="h-[58px] sm:h-[96px] lg:h-[104px]" />

      <main className="flex-1">
        <div className="mx-auto max-w-[1200px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
          {/* Back button */}
          <button
            onClick={() => navigate(-1)}
            className="group mb-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-[color:var(--brand-green)]/30 hover:bg-[color:var(--brand-mist)] hover:text-[color:var(--brand-green)]"
          >
            <ArrowLeft className="size-4 transition group-hover:-translate-x-0.5" />
            {t("common.back")}
          </button>

          {/* Step indicator */}
          <div className="mb-8">
            <StepIndicator steps={steps} currentStep={step} />
          </div>

          {/* Mobile summary card */}
          <div className="mb-6 md:hidden">
            <MobileSummaryCard
              tour={activeTour}
              onChangeClick={() => setIsChangeModalOpen(true)}
            />
          </div>

          <div className="grid gap-8 md:grid-cols-[1fr_300px] lg:grid-cols-[1fr_360px]">
            {/* ─── Left: Form steps ─── */}
            <div className="min-w-0 space-y-6">
              <AnimatePresence mode="wait">
                {step === 1 && (
                  <motion.div
                    key="step1"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.25 }}
                  >
                    <ContactDetailsStep
                      data={contact}
                      onChange={handleContactChange}
                      onNext={() =>
                        contactValid.all ? handleNext(2) : undefined
                      }
                      valid={contactValid}
                    />
                  </motion.div>
                )}

                {step === 2 && (
                  <motion.div
                    key="step2"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.25 }}
                  >
                    <ActivityDetailsStep
                      data={activity}
                      onChange={handleActivityChange}
                      tour={activeTour}
                      onNext={() =>
                        activityValid.all ? handleNext(3) : undefined
                      }
                      valid={activityValid}
                    />
                  </motion.div>
                )}

                {step === 3 && (
                  <motion.div
                    key="step3"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.25 }}
                  >
                    <PaymentDetailsStep
                      data={payment}
                      onChange={handlePaymentChange}
                      tour={activeTour}
                      onBook={handleBook}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ─── Right: Sticky sidebar ─── */}
            <aside className="hidden md:block">
              <div className="sticky top-28">
                <BookingSidebar
                  tour={activeTour}
                  promoCode={promoCode}
                  setPromoCode={setPromoCode}
                  onApplyPromo={handleApplyPromo}
                  onChangeClick={() => setIsChangeModalOpen(true)}
                />
              </div>
            </aside>
          </div>
        </div>
      </main>

      <AnimatePresence>
        {isChangeModalOpen && (
          <ChangeBookingModal
            tour={activeTour}
            isOpen={isChangeModalOpen}
            onClose={() => setIsChangeModalOpen(false)}
            onReserve={(updates) =>
              setEditableTour((prev) => ({
                ...prev,
                ...updates,
                price: updates.price,
              }))
            }
          />
        )}
      </AnimatePresence>

      <Footer />
    </div>
  );
}
