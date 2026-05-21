import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import BrandLoader from "@/components/ui/BrandLoader";
import { useAuth } from "@/components/auth/AuthProvider";

function SignOutPage() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { t } = useTranslation();

  useEffect(() => {
    let mounted = true;

    signOut()
      .catch(() => {})
      .finally(() => {
        if (!mounted) {
          return;
        }

        navigate("/", { replace: true, state: { showLogoutToast: true } });
      });

    return () => {
      mounted = false;
    };
  }, [signOut, navigate]);

  return <BrandLoader fullScreen label={t("auth.signingOut")} />;
}

export default SignOutPage;
