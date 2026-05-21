import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Textarea component with consistent styling
 */
const Textarea = forwardRef(({ 
  className, 
  error,
  rows = 4,
  ...props 
}, ref) => {
  return (
    <textarea
      rows={rows}
      className={cn(
        "w-full px-3 py-2.5 border rounded-lg text-sm text-slate-900 placeholder:text-slate-400",
        "focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]",
        "disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed",
        "resize-vertical transition-colors",
        error 
          ? "border-red-300 focus:border-red-500 focus:ring-red-500/20" 
          : "border-slate-300",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";

export default Textarea;
