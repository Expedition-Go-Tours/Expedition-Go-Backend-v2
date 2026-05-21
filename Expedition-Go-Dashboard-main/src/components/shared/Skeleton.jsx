import { cn } from "@/lib/utils";

/**
 * Skeleton loader component for displaying loading states
 * @param {Object} props - Component props
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.variant - Skeleton variant (text, circular, rectangular)
 * @param {number} props.width - Width in pixels or percentage
 * @param {number} props.height - Height in pixels
 * @param {number} props.count - Number of skeleton items to render
 */
export default function Skeleton({ 
  className, 
  variant = "rectangular",
  width,
  height,
  count = 1,
  ...props 
}) {
  const baseClasses = "animate-pulse bg-gradient-to-r from-slate-200 via-slate-100 to-slate-200 bg-[length:200%_100%]";
  
  const variantClasses = {
    text: "h-4 rounded",
    circular: "rounded-full",
    rectangular: "rounded-lg",
  };

  const style = {
    width: width ? (typeof width === 'number' ? `${width}px` : width) : undefined,
    height: height ? `${height}px` : undefined,
  };

  const skeletonElement = (
    <div
      className={cn(baseClasses, variantClasses[variant], className)}
      style={style}
      {...props}
    />
  );

  if (count > 1) {
    return (
      <div className="space-y-2">
        {Array.from({ length: count }).map((_, index) => (
          <div key={index}>{skeletonElement}</div>
        ))}
      </div>
    );
  }

  return skeletonElement;
}

// Specialized skeleton components
export function TableSkeleton({ rows = 5, columns = 6 }) {
  return (
    <div className="bg-white rounded-lg border border-[#eaeaea] overflow-hidden">
      {/* Table Header */}
      <div className="border-b border-[#eaeaea] p-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton key={i} height={16} />
          ))}
        </div>
      </div>
      
      {/* Table Rows */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="border-b border-[#eaeaea] p-4 last:border-b-0">
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
            {Array.from({ length: columns }).map((_, colIndex) => (
              <Skeleton key={colIndex} height={20} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ count = 1 }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="bg-white rounded-lg border border-[#eaeaea] p-4">
          <Skeleton height={200} className="mb-4" />
          <Skeleton height={24} className="mb-2" />
          <Skeleton height={16} width="60%" className="mb-4" />
          <div className="flex items-center justify-between">
            <Skeleton height={20} width={80} />
            <Skeleton height={32} width={100} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 300 }) {
  return (
    <div className="bg-white rounded-lg border border-[#eaeaea] p-6">
      <Skeleton height={24} width="40%" className="mb-4" />
      <Skeleton height={height} />
    </div>
  );
}

export function FormSkeleton({ fields = 5 }) {
  return (
    <div className="bg-white rounded-lg border border-[#eaeaea] p-6 space-y-6">
      {Array.from({ length: fields }).map((_, index) => (
        <div key={index}>
          <Skeleton height={16} width={120} className="mb-2" />
          <Skeleton height={40} />
        </div>
      ))}
      <div className="flex gap-3 justify-end pt-4">
        <Skeleton height={40} width={100} />
        <Skeleton height={40} width={100} />
      </div>
    </div>
  );
}

export function StatCardSkeleton({ count = 4 }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="bg-white rounded-lg border border-[#eaeaea] p-6">
          <div className="flex items-center justify-between mb-4">
            <Skeleton variant="circular" width={48} height={48} />
            <Skeleton height={20} width={60} />
          </div>
          <Skeleton height={32} width="60%" className="mb-2" />
          <Skeleton height={16} width="40%" />
        </div>
      ))}
    </div>
  );
}
