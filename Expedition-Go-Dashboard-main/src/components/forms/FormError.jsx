import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";

/**
 * FormError component for displaying field-level errors
 * @param {Object} props - Component props
 * @param {string} props.className - Additional CSS classes
 * @param {React.ReactNode} props.children - Error message
 */
export default function FormError({ className, children, ...props }) {
  if (!children) return null;

  return (
    <div
      className={cn(
        "flex items-start gap-1.5 text-sm text-red-600",
        className
      )}
      role="alert"
      {...props}
    >
      <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}
