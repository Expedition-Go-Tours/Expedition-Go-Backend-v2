import { ShieldCheck, Sparkles, Globe } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useState, useRef, useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import companyLogo from "@/assets/images/new_logo.png";

function AuthShell({ title, description, badgeLabel, children, footerText, footerLinkLabel, footerLinkTo }) {
  const { t, i18n } = useTranslation();
  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const menuRef = useRef(null);

  const languages = [
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'es', name: 'Español', flag: '🇪🇸' },
    { code: 'fr', name: 'Français', flag: '🇫🇷' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
    { code: 'nl', name: 'Nederlands', flag: '🇳🇱' }
  ];

  const currentLanguage = languages.find(lang => lang.code === i18n.language) || languages[0];

  const changeLanguage = (langCode) => {
    i18n.changeLanguage(langCode);
    localStorage.setItem('language', langCode);
    setShowLanguageMenu(false);
  };

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowLanguageMenu(false);
      }
    }

    if (showLanguageMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showLanguageMenu]);
  
  return (
    <div className="min-h-screen bg-[color:var(--page-bg)]">
      {/* Language Selector - Fixed top right */}
      <div className="fixed top-4 right-4 z-50" ref={menuRef}>
        <button
          onClick={() => setShowLanguageMenu(!showLanguageMenu)}
          className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-lg border border-slate-200 hover:bg-slate-50 transition"
        >
          <Globe className="h-4 w-4" />
          <span>{currentLanguage.flag} {currentLanguage.name}</span>
        </button>

        {showLanguageMenu && (
          <div className="absolute right-0 mt-2 w-48 rounded-2xl bg-white shadow-xl border border-slate-200 py-2 overflow-hidden">
            {languages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => changeLanguage(lang.code)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition ${
                  i18n.language === lang.code
                    ? 'bg-[color:var(--brand-mist)] text-[color:var(--brand-green)] font-semibold'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="text-lg">{lang.flag}</span>
                <span>{lang.name}</span>
                {i18n.language === lang.code && (
                  <span className="ml-auto text-[color:var(--brand-green)]">✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-[color:var(--brand-green)] text-white lg:flex">
          <img
            src="https://images.unsplash.com/photo-1516026672322-bc52d61a55d5?auto=format&fit=crop&w=1600&q=80"
            alt="Sunset safari landscape"
            className="absolute inset-0 h-full w-full object-cover opacity-100"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.5),rgba(0,0,0,0.65)),radial-gradient(circle_at_top,rgba(255,185,71,0.15),transparent_40%)]" />

          <div className="relative flex w-full flex-col justify-between p-10 xl:p-14">
            <Link to="/" className="inline-flex items-center gap-3 self-start">
              <img
                src={companyLogo}
                alt="Expedition-Go Group Limited"
                className="h-auto w-[136px] xl:w-[190px] object-contain"
              />
            </Link>

            <div className="max-w-xl">
              <Badge variant="soft" className="border-white/15 bg-white/10 text-white backdrop-blur">
                <Sparkles className="mr-2 size-3.5" />
                {t('auth.trustedExperiences')}
              </Badge>
              <h1 className="mt-6 text-5xl font-black tracking-tight text-white">{t('auth.bookManageJourney')}</h1>
              <p className="mt-5 max-w-lg text-base leading-8 text-white/76">
                {t('auth.secureAccess')}
              </p>
            </div>

            <div className="grid max-w-xl gap-4 md:grid-cols-2">
              <div className="rounded-[24px] border border-white/10 bg-white/8 p-5 backdrop-blur-sm">
                <ShieldCheck className="size-5 text-white" />
                <p className="mt-4 text-lg font-semibold">{t('auth.protectedAccess')}</p>
                <p className="mt-2 text-sm leading-6 text-white/72">{t('auth.protectedAccessDesc')}</p>
              </div>
              <div className="rounded-[24px] border border-white/10 bg-white/8 p-5 backdrop-blur-sm">
                <Sparkles className="size-5 text-white" />
                <p className="mt-4 text-lg font-semibold">{t('auth.fastReturn')}</p>
                <p className="mt-2 text-sm leading-6 text-white/72">{t('auth.fastReturnDesc')}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center px-4 py-10 sm:px-6 lg:px-10">
          <Card className="w-full max-w-xl rounded-[30px] border border-slate-200 bg-white shadow-[0_28px_70px_rgba(15,23,42,0.08)]">
            <CardContent className="p-7 sm:p-9">
              {badgeLabel ? (
                <Badge variant="outline" className="border-[color:var(--brand-green)]/12 bg-[color:var(--brand-mist)] text-[color:var(--brand-green)]">
                  {badgeLabel}
                </Badge>
              ) : null}
              <h2 className="mt-5 text-4xl font-black tracking-tight text-slate-900">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-slate-500">{description}</p>

              <div className="mt-8">{children}</div>

              <div className="mt-8 text-center text-sm text-slate-500">
                {footerText}{" "}
                <Link to={footerLinkTo} className="font-semibold text-[color:var(--brand-green)]">
                  {footerLinkLabel}
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

export default AuthShell;
