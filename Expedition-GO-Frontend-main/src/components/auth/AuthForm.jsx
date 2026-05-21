import { useState } from "react";
import { AlertCircle, LoaderCircle, Mail, Lock, UserRound } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInWithGoogle } from "@/lib/auth";

function GoogleIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24">
      <path
        d="M21.805 12.23c0-.79-.068-1.545-.214-2.27H12.2v4.292h5.37a4.6 4.6 0 0 1-1.99 3.02v2.51h3.223c1.886-1.738 3.002-4.306 3.002-7.552Z"
        fill="#4285F4"
      />
      <path
        d="M12.2 22c2.687 0 4.945-.882 6.603-2.39l-3.223-2.51c-.895.61-2.04.967-3.38.967-2.6 0-4.804-1.752-5.59-4.11H3.285v2.59A9.959 9.959 0 0 0 12.2 22Z"
        fill="#34A853"
      />
      <path
        d="M6.61 13.956A5.98 5.98 0 0 1 6.3 12c0-.68.117-1.34.31-1.956V7.454H3.285a9.966 9.966 0 0 0 0 9.092l3.325-2.59Z"
        fill="#FBBC05"
      />
      <path
        d="M12.2 5.933c1.463 0 2.773.503 3.806 1.488l2.85-2.85C17.14 2.968 14.883 2 12.2 2a9.959 9.959 0 0 0-8.915 5.454l3.325 2.59c.786-2.358 2.99-4.11 5.59-4.11Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function Field({ icon: Icon, label, ...props }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-slate-700">{label}</span>
      <div className="flex items-center rounded-[1.4rem] border border-slate-200 bg-slate-50 px-4 shadow-sm transition focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/10">
        <Icon className="h-4 w-4 text-slate-400" />
        <Input
          className="border-0 bg-transparent px-3 shadow-none focus:border-0 focus:ring-0"
          {...props}
        />
      </div>
    </label>
  );
}

export function AuthForm({
  mode,
  onSubmit,
  submitLabel,
  alternateLabel,
  alternateHref,
  alternateAction,
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const isRegister = mode === "register";

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!form.email || !form.password) {
      setError(t('auth.errorEmailPassword'));
      return;
    }

    if (isRegister && form.password !== form.confirmPassword) {
      setError(t('auth.errorPasswordMatch'));
      return;
    }

    setLoading(true);

    try {
      await onSubmit({
        name: form.name,
        email: form.email,
        password: form.password,
      });

      // Simple success message without Firebase details
      setSuccess(
        isRegister
          ? t('auth.successAccountCreated')
          : t('auth.successWelcomeBack')
      );

      navigate("/", {
        state: {
          postAuthSplash: true,
          splashKind: isRegister ? "register" : "signin",
          handoffId: Date.now(),
        },
      });
    } catch (submissionError) {
      setError(submissionError.message || t('auth.errorRequest'));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setError("");
    setSuccess("");
    setGoogleLoading(true);

    try {
      await signInWithGoogle();
      // Simple success message without Firebase details
      setSuccess(t('auth.successGoogleSignIn'));

      navigate("/", { state: { postAuthSplash: true, splashKind: "signin", handoffId: Date.now() } });
    } catch (submissionError) {
      setError(submissionError.message || "We couldn't complete Google sign-in.");
    } finally {
      setGoogleLoading(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      {isRegister ? (
        <Field
          autoComplete="name"
          icon={UserRound}
          label={t('auth.fullName')}
          onChange={(event) => updateField("name", event.target.value)}
          placeholder="Ama Mensah"
          value={form.name}
        />
      ) : null}

      <Field
        autoComplete="email"
        icon={Mail}
        label={t('auth.emailAddress')}
        onChange={(event) => updateField("email", event.target.value)}
        placeholder="you@example.com"
        type="email"
        value={form.email}
      />

      <Field
        autoComplete={isRegister ? "new-password" : "current-password"}
        icon={Lock}
        label={t('auth.password')}
        onChange={(event) => updateField("password", event.target.value)}
        placeholder="Enter your password"
        type="password"
        value={form.password}
      />

      {isRegister ? (
        <Field
          autoComplete="new-password"
          icon={Lock}
          label={t('auth.confirmPassword')}
          onChange={(event) => updateField("confirmPassword", event.target.value)}
          placeholder="Confirm your password"
          type="password"
          value={form.confirmPassword}
        />
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-[1.3rem] border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {success ? (
        <div className="rounded-[1.3rem] border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}
        </div>
      ) : null}

      <Button className="mt-2 h-12 w-full text-base" disabled={loading} type="submit">
        {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
        {submitLabel}
      </Button>

      <div className="flex items-center gap-3 py-2">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
          {t('auth.orContinueWith')}
        </span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <Button
        className="h-12 w-full rounded-[1.4rem]"
        disabled={googleLoading}
        onClick={handleGoogleSignIn}
        type="button"
        variant="outline"
      >
        {googleLoading ? (
          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <>
            <span>{t('auth.google')}</span>
            <GoogleIcon />
          </>
        )}
      </Button>

      <p className="text-center text-sm text-slate-600">
        {alternateLabel}{" "}
        <Link className="font-semibold text-primary hover:underline" to={alternateHref}>
          {alternateAction}
        </Link>
      </p>
    </form>
  );
}
