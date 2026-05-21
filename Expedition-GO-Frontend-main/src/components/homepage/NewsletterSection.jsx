import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/components/auth/AuthProvider";

export function NewsletterSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [isSubscribed, setIsSubscribed] = useState(false);

  useEffect(() => {
    setEmail(user?.email || "");
  }, [user?.email]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (email) {
      // Handle newsletter subscription
      setIsSubscribed(true);
      setTimeout(() => {
        setEmail(user?.email || "");
        setIsSubscribed(false);
      }, 3000);
    }
  };

  return (
    <section
      className="py-4 sm:py-12"
    >
      <div className="grid items-stretch gap-0 overflow-hidden rounded-xl border border-slate-200 shadow-lg sm:rounded-2xl lg:grid-cols-2">
        {/* Image Side */}
        <div
          className="relative h-[220px] overflow-hidden sm:h-[260px] lg:h-auto"
        >
          <img
            src="https://www.beingchristinajane.com/wp-content/uploads/2024/02/tour-sites-in-ghana-scaled.jpg"
            alt="Travel adventure"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-900/20 to-transparent" />
        </div>

        {/* Content Side */}
        <div
          className="min-w-0 flex flex-col justify-center bg-[color:var(--brand-mist)] p-5 sm:p-8 lg:p-12"
        >
          <h2 className="mb-3 leading-tight font-bold text-slate-900 break-words" style={{ fontSize: 'clamp(1.25rem, 2.5vw + 0.5rem, 2rem)' }}>
            {t('newsletter.title')}
          </h2>
          
          <p className="mb-5 break-words leading-6 text-slate-700 sm:mb-6" style={{ fontSize: 'clamp(0.875rem, 1vw + 0.5rem, 1.125rem)' }}>
            {t('newsletter.description')}
          </p>

          {/* Subscription Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 lg:flex-row">
            <div className="relative min-w-0 flex-1">
              <Input
                type="email"
                placeholder={t('newsletter.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11 border-slate-300 bg-white text-sm focus:border-[color:var(--brand-green)] focus:ring-[color:var(--brand-green)] sm:h-12"
              />
            </div>
            <Button
              type="submit"
              className="h-11 w-full rounded-lg bg-[color:var(--brand-green)] px-6 text-center text-sm font-semibold !text-white transition-all duration-300 hover:bg-[color:var(--brand-green)]/90 hover:shadow-lg sm:h-12 lg:w-auto lg:shrink-0 lg:px-8"
              disabled={isSubscribed}
            >
              {isSubscribed ? t('newsletter.subscribed') : t('newsletter.signUp')}
            </Button>
          </form>

          {isSubscribed && (
            <p
              className="mt-3 break-words text-sm font-medium text-[color:var(--brand-green)]"
            >
              ✓ Thank you for subscribing! Check your inbox for exclusive deals.
            </p>
          )}

          <p className="mt-4 break-words text-xs leading-5 text-slate-600 sm:text-sm">
            {t('newsletter.privacy')}{" "}
            <a href="#" className="text-[color:var(--brand-green)] hover:underline">{t('newsletter.privacyLink')}</a>.
          </p>
        </div>
      </div>
    </section>
  );
}
