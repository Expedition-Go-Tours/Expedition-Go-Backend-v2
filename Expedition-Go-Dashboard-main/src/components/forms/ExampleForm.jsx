import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormField from "./FormField";
import Input from "./Input";
import Textarea from "./Textarea";
import Select from "./Select";
import Checkbox from "./Checkbox";
import { ButtonSpinner } from "../shared/LoadingSpinner";

/**
 * Example form component demonstrating React Hook Form + Zod integration
 * This is a reference implementation - copy and adapt for your specific forms
 */
export default function ExampleForm({ schema, onSubmit, defaultValues = {} }) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues,
  });

  const handleFormSubmit = async (data) => {
    try {
      await onSubmit(data);
      reset();
    } catch (error) {
      console.error("Form submission error:", error);
    }
  };

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      {/* Text Input Example */}
      <FormField
        label="Email"
        required
        error={errors.email?.message}
        hint="We'll never share your email"
      >
        <Input
          type="email"
          placeholder="you@example.com"
          error={errors.email}
          {...register("email")}
        />
      </FormField>

      {/* Password Input Example */}
      <FormField
        label="Password"
        required
        error={errors.password?.message}
      >
        <Input
          type="password"
          placeholder="Enter your password"
          error={errors.password}
          {...register("password")}
        />
      </FormField>

      {/* Textarea Example */}
      <FormField
        label="Description"
        error={errors.description?.message}
        hint="Provide a detailed description"
      >
        <Textarea
          placeholder="Enter description..."
          error={errors.description}
          {...register("description")}
        />
      </FormField>

      {/* Select Example */}
      <FormField
        label="Category"
        required
        error={errors.category?.message}
      >
        <Select error={errors.category} {...register("category")}>
          <option value="">Select a category</option>
          <option value="safari">Safari</option>
          <option value="beach">Beach</option>
          <option value="adventure">Adventure</option>
        </Select>
      </FormField>

      {/* Checkbox Example */}
      <FormField error={errors.terms?.message}>
        <Checkbox
          label="I agree to the terms and conditions"
          error={errors.terms}
          {...register("terms")}
        />
      </FormField>

      {/* Submit Button */}
      <div className="flex items-center gap-3 justify-end pt-4">
        <button
          type="button"
          onClick={() => reset()}
          disabled={isSubmitting}
          className="px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting && <ButtonSpinner />}
          {isSubmitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </form>
  );
}
