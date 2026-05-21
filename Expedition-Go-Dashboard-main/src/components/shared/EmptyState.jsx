import { cn } from "@/lib/utils";
import { 
  FileX, 
  Search, 
  Filter, 
  Package, 
  Users, 
  Calendar, 
  Bell, 
  Star,
  DollarSign,
  BarChart3,
  Inbox
} from "lucide-react";

const iconMap = {
  default: Inbox,
  search: Search,
  filter: Filter,
  bookings: Calendar,
  products: Package,
  users: Users,
  notifications: Bell,
  reviews: Star,
  finance: DollarSign,
  analytics: BarChart3,
  notFound: FileX,
};

/**
 * EmptyState component for displaying when no data is available
 * @param {Object} props - Component props
 * @param {string} props.icon - Icon name from iconMap
 * @param {string} props.title - Main heading text
 * @param {string} props.description - Supporting description text
 * @param {React.ReactNode} props.action - Optional action button or element
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.size - Size variant (sm, md, lg)
 */
export default function EmptyState({
  icon = "default",
  title = "No data available",
  description,
  action,
  className,
  size = "md",
  ...props
}) {
  const Icon = iconMap[icon] || iconMap.default;

  const sizeClasses = {
    sm: {
      container: "py-8",
      icon: 40,
      title: "text-base",
      description: "text-sm",
    },
    md: {
      container: "py-12",
      icon: 56,
      title: "text-lg",
      description: "text-base",
    },
    lg: {
      container: "py-16",
      icon: 72,
      title: "text-xl",
      description: "text-lg",
    },
  };

  const currentSize = sizeClasses[size];

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        currentSize.container,
        className
      )}
      {...props}
    >
      {/* Icon */}
      <div className="mb-4 p-4 bg-slate-50 rounded-full">
        <Icon 
          size={currentSize.icon} 
          className="text-slate-400" 
          strokeWidth={1.5}
        />
      </div>

      {/* Title */}
      <h3 className={cn("font-semibold text-slate-900 mb-2", currentSize.title)}>
        {title}
      </h3>

      {/* Description */}
      {description && (
        <p className={cn("text-slate-500 max-w-md mb-6", currentSize.description)}>
          {description}
        </p>
      )}

      {/* Action */}
      {action && <div>{action}</div>}
    </div>
  );
}

// Specialized empty state components
export function EmptySearchResults({ searchQuery, onClear }) {
  return (
    <EmptyState
      icon="search"
      title="No results found"
      description={
        searchQuery
          ? `We couldn't find any results for "${searchQuery}". Try adjusting your search terms.`
          : "Try searching with different keywords."
      }
      action={
        onClear && (
          <button
            onClick={onClear}
            className="px-4 py-2 text-sm font-medium text-[#044b3b] hover:bg-slate-50 rounded-lg transition-colors"
          >
            Clear search
          </button>
        )
      }
    />
  );
}

export function EmptyFilterResults({ onClear }) {
  return (
    <EmptyState
      icon="filter"
      title="No matches found"
      description="No items match your current filters. Try adjusting or clearing your filters."
      action={
        onClear && (
          <button
            onClick={onClear}
            className="px-4 py-2 text-sm font-medium text-[#044b3b] hover:bg-slate-50 rounded-lg transition-colors"
          >
            Clear all filters
          </button>
        )
      }
    />
  );
}

export function EmptyTableState({ 
  icon = "default",
  title = "No data available",
  description = "There are no items to display at the moment.",
  action 
}) {
  return (
    <div className="bg-white rounded-lg border border-[#eaeaea]">
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        action={action}
        size="lg"
      />
    </div>
  );
}
