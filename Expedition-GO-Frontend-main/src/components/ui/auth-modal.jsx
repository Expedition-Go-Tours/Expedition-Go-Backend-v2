import { X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "./button";
import { useEffect } from "react";

export function AuthModal({ isOpen, onClose }) {
  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-[200] flex cursor-pointer items-center justify-center p-4 sm:p-6 md:p-8 animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Full-screen blurred backdrop */}
      <div className="absolute inset-0 cursor-pointer bg-black/60 backdrop-blur-md" />
      
      {/* Modal */}
      <div 
        className="relative w-full max-w-md cursor-default animate-in zoom-in-95 duration-200 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 grid size-8 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          aria-label="Close modal"
        >
          <X className="size-5" />
        </button>

        {/* Content */}
        <div className="text-center">
          {/* Icon */}
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-[color:var(--brand-mist)]">
            <svg
              className="size-8 text-[color:var(--brand-green)]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
          </div>

          {/* Title */}
          <h3 className="mt-4 text-xl font-bold text-slate-900 sm:text-2xl">
            Sign in to save favorites
          </h3>

          {/* Description */}
          <p className="mt-2 text-sm text-slate-600 sm:text-base">
            Create an account or sign in to save your favorite tours and destinations for later.
          </p>

          {/* Actions */}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              variant="default"
              className="flex-1 !text-white"
            >
              <Link to="/signin">Sign In</Link>
            </Button>
            <Button
              asChild
              variant="default"
              className="flex-1 !text-white"
            >
              <Link to="/register">Create Account</Link>
            </Button>
          </div>

          {/* Footer */}
          <p className="mt-4 text-xs text-slate-500">
            By continuing, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}
