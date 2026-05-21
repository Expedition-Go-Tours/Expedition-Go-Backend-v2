import { Check, AlertTriangle, Eye } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

export default function ProductReviewStep() {
  const { product, steps, currentStep } = useProductBuilderStore();

  // Validate all previous steps — must match backend validateTourData exactly
  const validationResults = steps.map((_, index) => {
    const stepErrors = {};
    switch (index) {
      case 0: // Product Type
        if (!product.productType) stepErrors.productType = "Product type required";
        if (product.productType === "tour") {
          if (!product.tourTransportationModes?.length) stepErrors.tourTransportationModes = "Transportation modes required";
          if (!product.tourDurationCategory) stepErrors.tourDurationCategory = "Tour duration required";
        }
        if (product.productType === "activity") {
          if (!product.activityCategories?.length) stepErrors.activityCategories = "Activity categories required";
        }
        if (product.productType === "transport") {
          if (!product.transportCategories?.length) stepErrors.transportCategories = "Transportation types required";
        }
        break;

      case 1: // Basics
        if (!product.title?.trim()) {
          stepErrors.title = "Title required";
        } else if (product.title.length > 200) {
          stepErrors.title = "Title must be less than 200 characters";
        }

        if (!product.description?.trim()) {
          stepErrors.description = "Description required";
        } else if (product.description.trim().length < 50) {
          stepErrors.description = "Description must be at least 50 characters";
        } else if (product.description.length > 5000) {
          stepErrors.description = "Description must be less than 5000 characters";
        }

        if (!product.subcategory?.trim()) stepErrors.subcategory = "Subcategory required";
        if (!product.activityType) stepErrors.activityType = "Activity type required";
        if (!product.city?.trim()) stepErrors.city = "City required";
        if (!product.country?.trim()) stepErrors.country = "Country required";
        if (!product.metaTitle?.trim()) stepErrors.metaTitle = "Meta title required";
        if (!product.duration) stepErrors.duration = "Duration required";

        // Lat/lng both or neither
        const hasLat = product.latitude !== null && product.latitude !== undefined && product.latitude !== '';
        const hasLng = product.longitude !== null && product.longitude !== undefined && product.longitude !== '';
        if (hasLat !== hasLng) {
          if (hasLat) stepErrors.longitude = "Both latitude and longitude must be provided together";
          if (hasLng) stepErrors.latitude = "Both latitude and longitude must be provided together";
        }
        if (hasLat) {
          const lat = Number(product.latitude);
          if (Number.isNaN(lat) || lat < -90 || lat > 90) {
            stepErrors.latitude = "Latitude must be between -90 and 90";
          }
        }
        if (hasLng) {
          const lng = Number(product.longitude);
          if (Number.isNaN(lng) || lng < -180 || lng > 180) {
            stepErrors.longitude = "Longitude must be between -180 and 180";
          }
        }
        break;

      case 2: // Content
        if (!product.content.itinerary?.trim()) stepErrors.itinerary = "Itinerary required";
        if (!product.content.meetingInstructions?.trim()) stepErrors.meetingInstructions = "Meeting instructions required";
        if (!product.content.uniqueSellingPoints?.trim()) stepErrors.uniqueSellingPoints = "Unique selling points required";
        if (!product.content.languages?.length) stepErrors.languages = "Languages required";
        break;

      case 3: // Photos
        if (!product.photos || product.photos.length === 0) {
          stepErrors.photos = "At least one photo is required";
        } else if (product.photos.length > 20) {
          stepErrors.photos = "Maximum 20 photos allowed";
        }
        break;

      case 4: // Pricing
        if (!product.pricing.basePrice || Number(product.pricing.basePrice) <= 0) {
          stepErrors.price = "Base price must be greater than 0";
        }
        if (!product.pricing.startDate) stepErrors.pricingStartDate = "Pricing start date required";
        if (!product.pricing.endDate) stepErrors.pricingEndDate = "Pricing end date required";
        if (!product.pricing.currency || product.pricing.currency.length !== 3) {
          stepErrors.currency = "Valid 3-letter currency code required";
        }
        if (!product.pricing.tiers || product.pricing.tiers.length === 0) {
          stepErrors.pricingSchedule = "At least one pricing schedule required";
        }
        break;

      case 5: // Schedule
        if (!product.schedule.operatingDays?.length) stepErrors.days = "Operating days required";
        break;

      case 6: // Booking Rules
        if (!product.bookingRules.meetingPoint?.trim()) stepErrors.meeting = "Meeting point required";
        if (!product.bookingRules.meetingPointAddress?.trim()) stepErrors.meetingPointAddress = "Meeting point address required";
        break;

      default:
        break;
    }

    // Global tag limit
    if (product.tags && product.tags.length > 10) {
      stepErrors.tags = "Maximum 10 tags allowed";
    }

    return { step: index, isValid: Object.keys(stepErrors).length === 0, errors: stepErrors };
  });

  const allValid = validationResults.every((r) => r.isValid);

  return (
    <div className="space-y-6">
      {/* Validation Summary */}
      <div className={`p-4 rounded-lg border ${allValid ? "bg-[#ebfcf5] border-[#00d67f]" : "bg-[#fffbeb] border-[#ffc400]"}`}>
        <div className="flex items-center gap-3">
          {allValid ? (
            <Check size={20} className="text-[#00d67f]" />
          ) : (
            <AlertTriangle size={20} className="text-[#ffc400]" />
          )}
          <div>
            <p className={`text-sm font-semibold ${allValid ? "text-[#047857]" : "text-[#b45309]"}`}>
              {allValid ? "All checks passed! Ready to submit." : "Some fields need attention before submitting."}
            </p>
          </div>
        </div>
      </div>

      {/* Step-by-step validation */}
      <div className="space-y-3">
        {steps.slice(0, -1).map((step, index) => {
          const result = validationResults[index];
          return (
            <div
              key={step.id}
              className={`flex items-start gap-3 p-3 rounded-lg border ${
                result.isValid ? "bg-[#f8fafc] border-[#eaeaea]" : "bg-[#fffbeb] border-[#ffc400]"
              }`}
            >
              <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                result.isValid ? "bg-[#00d67f]" : "bg-[#ffc400]"
              }`}>
                {result.isValid ? (
                  <Check size={12} className="text-white" />
                ) : (
                  <span className="text-white text-xs font-bold">!</span>
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-[#1e293b]">
                  {step.number}. {step.label}
                </p>
                {!result.isValid && (
                  <ul className="mt-1 space-y-0.5">
                    {Object.values(result.errors).map((err, i) => (
                      <li key={i} className="text-xs text-[#b45309]">• {err}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Product Preview */}
      <div className="border border-[#eaeaea] rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-[#f8fafc] border-b border-[#eaeaea] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[#1e293b]">Product Preview</h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-[#64748b]">Product Type:</span>
              <span className="ml-2 text-[#1e293b] font-medium capitalize">{product.productType || "—"}</span>
            </div>
            {product.productType === "activity" && (
              <div>
                <span className="text-[#64748b]">Activities:</span>
                <span className="ml-2 text-[#1e293b] font-medium">
                  {product.activityCategories?.length > 0
                    ? `${product.activityCategories.length} selected`
                    : "—"}
                </span>
              </div>
            )}
            {product.productType === "transport" && (
              <div>
                <span className="text-[#64748b]">Transport Types:</span>
                <span className="ml-2 text-[#1e293b] font-medium">
                  {product.transportCategories?.length > 0
                    ? `${product.transportCategories.length} selected`
                    : "—"}
                </span>
              </div>
            )}
            <div>
              <span className="text-[#64748b]">Title:</span>
              <span className="ml-2 text-[#1e293b] font-medium">{product.title || "—"}</span>
            </div>
            <div>
              <span className="text-[#64748b]">Category:</span>
              <span className="ml-2 text-[#1e293b] font-medium capitalize">{product.category || "—"}</span>
            </div>
            <div>
              <span className="text-[#64748b]">Subcategory:</span>
              <span className="ml-2 text-[#1e293b] font-medium">{product.subcategory || "—"}</span>
            </div>
            <div>
              <span className="text-[#64748b]">Activity Type:</span>
              <span className="ml-2 text-[#1e293b] font-medium">{product.activityType || "—"}</span>
            </div>
            <div>
              <span className="text-[#64748b]">City:</span>
              <span className="ml-2 text-[#1e293b] font-medium">{product.city || "—"}</span>
            </div>
            <div>
              <span className="text-[#64748b]">Country:</span>
              <span className="ml-2 text-[#1e293b] font-medium">{product.country || "—"}</span>
            </div>
            <div>
              <span className="text-[#64748b]">Duration:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.duration ? `${product.duration} ${product.durationUnit}` : "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Base Price:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.pricing.basePrice > 0 ? `$${product.pricing.basePrice}` : "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Operating Days:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.schedule.operatingDays.length > 0
                  ? `${product.schedule.operatingDays.length} days`
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Capacity:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.schedule.capacityPerSlot} per slot
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Pricing Dates:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.pricing.startDate && product.pricing.endDate
                  ? `${product.pricing.startDate} to ${product.pricing.endDate}`
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Meeting Address:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.bookingRules.meetingPointAddress || "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Languages:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.content.languages?.length > 0
                  ? product.content.languages.join(", ")
                  : "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Photos:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.photos?.length > 0 ? `${product.photos.length} uploaded` : "—"}
              </span>
            </div>
            <div>
              <span className="text-[#64748b]">Tags:</span>
              <span className="ml-2 text-[#1e293b] font-medium">
                {product.tags?.length > 0 ? product.tags.join(", ") : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Status Selection */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-3">Publish Status</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { value: "draft", label: "Draft", desc: "Save but don't publish" },
            { value: "active", label: "Active", desc: "Publish immediately" },
          ].map((status) => (
              <button
                key={status.value}
                onClick={() => useProductBuilderStore.getState().updateProduct({ status: status.value })}
                className={`p-3 sm:p-4 rounded-lg border-2 text-left transition-colors ${
                  product.status === status.value
                    ? "border-[#044b3b] bg-[#f0fdf4]"
                    : "border-[#eaeaea] hover:border-[#044b3b]/30"
                }`}
              >
                <div className="flex items-center gap-3">
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    product.status === status.value ? "border-[#044b3b] bg-[#044b3b]" : "border-[#eaeaea]"
                  }`}
                >
                  {product.status === status.value && <Check size={12} className="text-white" />}
                </div>
                <div>
                  <p className="text-sm font-semibold text-[#1e293b]">{status.label}</p>
                  <p className="text-xs text-[#64748b]">{status.desc}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
