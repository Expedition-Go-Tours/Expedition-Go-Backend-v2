import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Checkbox component with consistent styling
 */
const Checkbox = forwardRef(({ 
  className,
  label,
  error,
  ...props 
}, ref) => {
  const checkbox = (
    <input
      type="checkbox"
      className={cn(
        "w-4 h-4 rounded border-slate-300 text-[#044b3b]",
        "focus:ring-2 focus:ring-[#044b3b]/20 focus:ring-offset-0",
        "disabled:bg-slate-50 disabled:cursor-not-allowed",
        "transition-colors cursor-pointer",
        error && "border-red-300",
        className
      )}
      ref={ref}
      {...props}
    />
  );

  if (label) {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        {checkbox}
        <span className="text-sm text-slate-700">{label}</span>
      </label>
    );
  }

  return checkbox;
});

Checkbox.displayName = "Checkbox";

export default Checkbox;
