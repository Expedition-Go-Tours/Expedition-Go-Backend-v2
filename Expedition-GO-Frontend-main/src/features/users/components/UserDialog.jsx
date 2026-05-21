import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { AdminButton } from "@/components/ui/admin-button";
import { AdminInput, AdminLabel } from "@/components/ui/admin-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ALL_ADMIN_ROLES } from "@/lib/rbac";

const ROLE_OPTIONS = [...ALL_ADMIN_ROLES, "user"];
const STATUS_OPTIONS = ["active", "pending", "disabled"];

const userSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email"),
  role: z.string().min(1, "Role is required"),
  status: z.string().min(1, "Status is required"),
});

export function UserDialog({ open, onOpenChange, user, onSubmit, submitting }) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    watch,
    setValue,
  } = useForm({
    resolver: zodResolver(userSchema),
    defaultValues: {
      name: user?.name || "",
      email: user?.email || "",
      role: (user?.role || "user").toLowerCase(),
      status: (user?.status || "active").toLowerCase(),
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: user?.name || "",
        email: user?.email || "",
        role: (user?.role || "user").toLowerCase(),
        status: (user?.status || "active").toLowerCase(),
      });
    }
  }, [open, user, reset]);

  const role = watch("role");
  const status = watch("status");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? "Edit user" : "Create user"}</DialogTitle>
          <DialogDescription>
            Adjust the user details, role and access status. Changes apply immediately.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={handleSubmit((values) => onSubmit?.(values))}
        >
          <div className="grid gap-1.5">
            <AdminLabel htmlFor="user-name">Name</AdminLabel>
            <AdminInput id="user-name" placeholder="Full name" {...register("name")} />
            {errors.name ? (
              <p className="text-xs text-[color:var(--admin-danger)]">{errors.name.message}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <AdminLabel htmlFor="user-email">Email</AdminLabel>
            <AdminInput id="user-email" type="email" placeholder="name@example.com" {...register("email")} />
            {errors.email ? (
              <p className="text-xs text-[color:var(--admin-danger)]">{errors.email.message}</p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <AdminLabel>Role</AdminLabel>
              <Select value={role} onValueChange={(value) => setValue("role", value, { shouldValidate: true })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("role")} />
            </div>
            <div className="grid gap-1.5">
              <AdminLabel>Status</AdminLabel>
              <Select value={status} onValueChange={(value) => setValue("status", value, { shouldValidate: true })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("status")} />
            </div>
          </div>

          <DialogFooter>
            <AdminButton variant="outline" type="button" onClick={() => onOpenChange?.(false)}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" disabled={submitting || isSubmitting}>
              {submitting || isSubmitting ? "Saving..." : "Save changes"}
            </AdminButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
