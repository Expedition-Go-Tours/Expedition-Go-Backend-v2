import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/AuthShell";
import { AuthForm } from "@/components/auth/AuthForm";
import { registerWithEmail } from "@/lib/auth";

function RegisterPage() {
  const { t } = useTranslation();
  
  return (
    <AuthShell
      badgeLabel={t('auth.register')}
      title={t('auth.createYourAccount')}
      description={t('auth.registerDesc')}
      footerText={t('auth.alreadyHaveAccount')}
      footerLinkLabel={t('auth.signInHere')}
      footerLinkTo="/signin"
    >
      <AuthForm
        mode="register"
        onSubmit={({ name, email, password }) => registerWithEmail(name, email, password)}
        submitLabel={t('auth.createAccount')}
      />
    </AuthShell>
  );
}

export default RegisterPage;
