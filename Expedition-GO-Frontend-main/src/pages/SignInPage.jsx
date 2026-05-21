import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/AuthShell";
import { AuthForm } from "@/components/auth/AuthForm";
import { signInWithEmail } from "@/lib/auth";

function SignInPage() {
  const { t } = useTranslation();
  
  return (
    <AuthShell
      badgeLabel={t('auth.signIn')}
      title={t('auth.welcomeBack')}
      description={t('auth.signInDesc')}
      footerText={t('auth.needNewAccount')}
      footerLinkLabel={t('auth.registerHere')}
      footerLinkTo="/register"
    >
      <AuthForm
        mode="signin"
        onSubmit={({ email, password }) => signInWithEmail(email, password)}
        submitLabel={t('auth.signInButton')}
      />
    </AuthShell>
  );
}

export default SignInPage;
