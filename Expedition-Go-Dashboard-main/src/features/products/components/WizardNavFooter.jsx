import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Save, X, Loader2, CheckCircle2, AlertCircle, ArrowRight, Eye } from "lucide-react";
import { toast } from "sonner";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";
import { buildProductPayload } from "@/features/products/utils/buildProductPayload";
import { createProduct, updateProduct } from "@/features/products/api";

export default function WizardNavFooter() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentStep, steps, isDirty, isSaving, product, lastSaved, nextStep, prevStep, validateStep, setSaving } = useProductBuilderStore();
  const isFirst = currentStep === 0;
  const isLast = currentStep === steps.length - 1;

  // Track submission result for display in UI
  const [submitResult, setSubmitResult] = useState(null);

  const handleNext = () => {
    const isValid = validateStep(currentStep);
    if (isValid) {
      nextStep();
    }
  };

  const handleSave = () => {
    // Auto-save logic would go here
    useProductBuilderStore.getState().markSaved();
    toast.success("Draft saved locally");
  };

  const handleDiscard = () => {
    if (confirm("Are you sure you want to discard all changes?")) {
      useProductBuilderStore.getState().reset();
    }
  };

  const handleSubmit = async () => {
    // Reset any previous result
    setSubmitResult(null);

    // Validate ALL steps before submitting
    const allStepsValid = steps.every((_, index) => validateStep(index));
    if (!allStepsValid) {
      toast.error("Please complete all required fields before submitting.");
      return;
    }

    setSaving(true);
    console.log("🚀 [WizardNavFooter] Starting product submission...");
    console.log("📝 [WizardNavFooter] Product state:", product);

    try {
      let payload;
      try {
        payload = buildProductPayload(product);
        console.log("📦 [WizardNavFooter] Payload built successfully:", payload);
      } catch (buildErr) {
        console.error("💥 [WizardNavFooter] Failed to build payload:", buildErr);
        setSubmitResult({
          type: "error",
          status: null,
          title: "Payload Error",
          message: buildErr.message || "Failed to build product payload.",
          data: null,
        });
        toast.error("Failed to build product payload. Check console for details.");
        return;
      }

      console.log("🌐 [WizardNavFooter] Sending API request...");
      console.log("   Endpoint:", id && id !== "new" ? `PATCH /tours/${id}` : "POST /tours");
      console.log("   Payload keys:", Object.keys(payload));

      let response;
      if (id && id !== "new") {
        response = await updateProduct(id, payload);
      } else {
        response = await createProduct(payload);
      }

      console.log("✅ [WizardNavFooter] API call succeeded!");
      console.log("   Status:", response.status);
      console.log("   Response data:", response.data);

      setSubmitResult({
        type: "success",
        status: response.status,
        title: id && id !== "new" ? "Product Updated" : "Product Created",
        message: `Successfully saved to the database (HTTP ${response.status}).`,
        data: response.data,
      });

      toast.success(id && id !== "new" ? "Product updated successfully!" : "Product created successfully!");
      useProductBuilderStore.getState().markSaved();
    } catch (err) {
      console.error("❌ [WizardNavFooter] API call failed:", err);
      console.error("   Error name:", err.name);
      console.error("   Error message:", err.message);
      console.error("   Error response:", err.response);
      console.error("   Error response data:", err.response?.data);

      const status = err.response?.status;
      const isAuthError = status === 401;
      const message = isAuthError
        ? "Authentication failed. You need to log in before creating a product."
        : err.response?.data?.message || err.response?.data?.error || err.message || "Failed to save product. Please try again.";

      setSubmitResult({
        type: "error",
        status: status || null,
        title: isAuthError ? "Authentication Required" : "Submission Failed",
        message,
        data: err.response?.data || null,
      });

      toast.error(message);
    } finally {
      setSaving(false);
      console.log("🏁 [WizardNavFooter] Submission attempt finished.");
    }
  };

  const handleContinue = () => {
    navigate("/products");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Main Footer Buttons */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleDiscard}
            className="flex items-center gap-2 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] transition-colors"
          >
            <X size={16} />
            <span className="hidden sm:inline">Discard</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="flex items-center gap-2 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            <span className="hidden sm:inline">Save Draft</span>
          </button>
          {lastSaved && (
            <span className="text-xs text-[#9e9e9e]">
              Last saved: {new Date(lastSaved).toLocaleTimeString()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => prevStep()}
            disabled={isFirst}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-5 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] hover:text-[#1e293b] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
            <span className="hidden sm:inline">Previous</span>
          </button>

          {isLast ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSaving}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-5 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : null}
              <span>Submit for Review</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-5 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Submission Result Panel */}
      {submitResult && (
        <div
          className={`rounded-lg border p-4 space-y-3 ${
            submitResult.type === "success"
              ? "bg-[#f0fdf4] border-[#86efac]"
              : "bg-[#fef2f2] border-[#fca5a5]"
          }`}
        >
          {/* Header */}
          <div className="flex items-start gap-3">
            {submitResult.type === "success" ? (
              <CheckCircle2 size={20} className="text-[#16a34a] mt-0.5 flex-shrink-0" />
            ) : (
              <AlertCircle size={20} className="text-[#dc2626] mt-0.5 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4
                  className={`text-sm font-semibold ${
                    submitResult.type === "success" ? "text-[#166534]" : "text-[#991b1b]"
                  }`}
                >
                  {submitResult.title}
                </h4>
                {submitResult.status && (
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      submitResult.type === "success"
                        ? "bg-[#dcfce7] text-[#166534]"
                        : "bg-[#fee2e2] text-[#991b1b]"
                    }`}
                  >
                    HTTP {submitResult.status}
                  </span>
                )}
              </div>
              <p
                className={`text-sm mt-0.5 ${
                  submitResult.type === "success" ? "text-[#15803d]" : "text-[#b91c1c]"
                }`}
              >
                {submitResult.message}
              </p>
            </div>
          </div>

          {/* Response Data Preview */}
          {submitResult.data && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-[#64748b]" />
                <span className="text-xs font-medium text-[#64748b]">Response Data</span>
              </div>
              <div className="bg-white/80 rounded-md border border-black/5 p-3 overflow-x-auto">
                <pre className="text-xs text-[#1e293b] font-mono whitespace-pre-wrap break-all">
                  {JSON.stringify(submitResult.data, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-1">
            {submitResult.type === "success" && (
              <button
                onClick={handleContinue}
                className="flex items-center gap-2 px-4 py-2 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
              >
                <span>Continue to Products</span>
                <ArrowRight size={16} />
              </button>
            )}
            <button
              onClick={() => setSubmitResult(null)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                submitResult.type === "success"
                  ? "border border-[#86efac] text-[#166534] hover:bg-[#dcfce7]"
                  : "border border-[#fca5a5] text-[#991b1b] hover:bg-[#fee2e2]"
              }`}
            >
              <X size={16} />
              <span>Dismiss</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
