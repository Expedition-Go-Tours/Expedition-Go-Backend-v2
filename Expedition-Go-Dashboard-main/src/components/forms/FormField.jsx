import { cn } from "@/lib/utils";
import FormLabel from "./FormLabel";
import FormError from "./FormError";

/**
 * FormField wrapper component for consistent form field styling
 * @param {Object} props - Component props
 * @param {string} props.label - Field label
 * @param {string} props.error - Error message
 * @param {boolean} props.required - Whether field is required
 * @param {string} props.hint - Helper text
 * @param {React.ReactNode} props.children - Input element
 * @param {string} props.className - Additional CSS classes
 */
export default function FormField({
  label,
  error,
  required = false,
  hint,
  children,
  className,
  ...props
}) {
  return (
    <div className={cn("space-y-2", className)} {...props}>
      {label && <FormLabel required={required}>{label}</FormLabel>}
      
      {children}
      
      {hint && !error && (
        <p className="text-xs text-slate-500">{hint}</p>
      )}
      
      {error && <FormError>{error}</FormError>}
    </div>
  );
}
