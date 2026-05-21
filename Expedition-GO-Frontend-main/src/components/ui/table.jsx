import { cn } from "@/lib/utils";

function Table({ className, ...props }) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm text-[color:var(--admin-text)]", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-[color:var(--admin-border)]", className)} {...props} />;
}

function TableBody({ className, ...props }) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }) {
  return (
    <tr
      className={cn(
        "border-b border-[color:var(--admin-border)] transition-colors hover:bg-[color:var(--admin-border-soft)]/60 data-[state=selected]:bg-[color:var(--admin-brand-soft)]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }) {
  return (
    <th
      className={cn(
        "h-11 px-4 text-left align-middle text-xs font-semibold uppercase tracking-wider text-[color:var(--admin-muted)]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}

function TableCaption({ className, ...props }) {
  return <caption className={cn("mt-3 text-xs text-[color:var(--admin-muted)]", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption };
