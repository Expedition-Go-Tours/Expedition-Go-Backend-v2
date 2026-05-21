import { cn } from "@/lib/utils";

/**
 * Brand loading / splash visuals.
 * @param {{ fullScreen?: boolean; label?: string; splash?: boolean }} props
 * - `splash`: shorter wipe animation (~1s) for post–sign-in handoff (pair with ~1200ms timers).
 */
export function BrandLoader({ fullScreen = false, label = "Loading...", splash = false }) {
  const wrapperClass = fullScreen
    ? cn(
        "fixed inset-0 z-[120] flex items-center justify-center bg-white px-4 sm:px-6 min-h-[100dvh] min-h-[100svh]",
        "pt-[env(safe-area-inset-top,0)] pb-[env(safe-area-inset-bottom,0)]",
      )
    : "flex items-center justify-center px-4 sm:px-6";

  return (
    <div className={wrapperClass} role="status" aria-live="polite" aria-label={label}>
      <div className={cn("brand-loader", splash && "brand-loader--splash")}>
        <div className="brand-loader__fill-wrap">
          <div className="brand-loader__fill">
            <span className="brand-loader__travio">Travio</span>
            <span className="brand-loader__africa">Africa</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BrandLoader;
