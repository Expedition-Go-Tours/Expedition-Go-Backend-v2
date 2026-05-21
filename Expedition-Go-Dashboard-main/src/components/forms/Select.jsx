import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

/**
 * Select component with consistent styling
 */
const Select = forwardRef(({ 
  className, 
  error,
  children,
  ...props 
}, ref) => {
  return (
    <div className="relative">
      <select
        className={cn(
          "w-full px-3 py-2.5 pr-10 border rounded-lg text-sm text-slate-900",
          "focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]",
          "disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed",
          "appearance-none bg-white transition-colors cursor-pointer",
          error 
            ? "border-red-300 focus:border-red-500 focus:ring-red-500/20" 
            : "border-slate-300",
          className
        )}
        ref={ref}
        {...props}
      >
        {children}
      </select>
      <ChevronDown 
        size={16} 
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" 
      />
    </div>
  );
});

Select.displayName = "Select";

export default Select;
