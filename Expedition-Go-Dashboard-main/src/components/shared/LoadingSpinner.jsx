import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

/**
 * LoadingSpinner component for displaying loading indicators
 * @param {Object} props - Component props
 * @param {string} props.size - Size variant (xs, sm, md, lg, xl)
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.text - Optional loading text
 */
export default function LoadingSpinner({ 
  size = "md", 
  className,
  text,
  ...props 
}) {
  const sizeClasses = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-6 h-6",
    lg: "w-8 h-8",
    xl: "w-12 h-12",
  };

  return (
    <div className={cn("flex items-center justify-center gap-2", className)} {...props}>
      <Loader2 
        className={cn("animate-spin text-[#044b3b]", sizeClasses[size])} 
      />
      {text && (
        <span className="text-sm text-slate-600">{text}</span>
      )}
    </div>
  );
}

// Specialized loading components
export function PageLoader({ text = "Loading..." }) {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <LoadingSpinner size="lg" text={text} />
    </div>
  );
}

export function ButtonSpinner({ size = "sm" }) {
  return <LoadingSpinner size={size} className="mr-2" />;
}

export function OverlayLoader({ text = "Loading..." }) {
  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <LoadingSpinner size="lg" text={text} />
      </div>
    </div>
  );
}

export function InlineLoader({ text }) {
  return (
    <div className="flex items-center justify-center py-8">
      <LoadingSpinner size="md" text={text} />
    </div>
  );
}
