import { cn } from "@/lib/utils";

function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        "flex h-12 w-full rounded-full border border-[color:var(--brand-green)]/10 bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[color:var(--brand-green)]/35 focus:ring-4 focus:ring-[color:var(--brand-green)]/10",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
