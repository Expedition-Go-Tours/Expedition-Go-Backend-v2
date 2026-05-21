import { Plus, Trash2, DollarSign, Percent } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

const CURRENCIES = [
  { value: "USD", label: "USD ($)" },
  { value: "EUR", label: "EUR (€)" },
  { value: "GBP", label: "GBP (£)" },
  { value: "ZAR", label: "ZAR (R)" },
  { value: "KES", label: "KES (KSh)" },
];

const PRICING_MODELS = [
  { value: "perPerson", label: "Per Person" },
  { value: "perGroup", label: "Per Group" },
  { value: "flatRate", label: "Flat Rate" },
];

const CANCELLATION_POLICIES = [
  { value: "flexible", label: "Flexible - Full refund 24h before" },
  { value: "moderate", label: "Moderate - Full refund 72h before" },
  { value: "strict", label: "Strict - 50% refund 7 days before" },
  { value: "non-refundable", label: "Non-refundable" },
];

export default function ProductPricingStep() {
  const { product, errors, updateProduct, updateNested } = useProductBuilderStore();
  const { pricing } = product;

  const updateTier = (index, field, value) => {
    const newTiers = [...pricing.tiers];
    newTiers[index] = { ...newTiers[index], [field]: value };
    updateNested("pricing.tiers", newTiers);
  };

  const addTier = () => {
    const newTiers = [...pricing.tiers, { name: "", price: "", minAge: 0, maxAge: 99 }];
    updateNested("pricing.tiers", newTiers);
  };

  const removeTier = (index) => {
    const newTiers = pricing.tiers.filter((_, i) => i !== index);
    updateNested("pricing.tiers", newTiers);
  };

  return (
    <div className="space-y-6">
      {/* Base Price & Currency */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            <span className="flex items-center gap-2">
              <DollarSign size={16} className="text-[#64748b]" />
              Base Price <span className="text-[#dc3545]">*</span>
            </span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e] text-sm">$</span>
            <input
              type="number"
              value={pricing.basePrice}
              onChange={(e) => updateNested("pricing.basePrice", e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="0.00"
              min="0"
              step="0.01"
              className={`w-full pl-8 pr-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
                errors.basePrice ? "border-[#dc3545]" : "border-[#eaeaea]"
              }`}
            />
          </div>
          {errors.basePrice && <p className="mt-1 text-xs text-[#dc3545]">{errors.basePrice}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Currency <span className="text-[#dc3545]">*</span>
          </label>
          <select
            value={pricing.currency}
            onChange={(e) => updateNested("pricing.currency", e.target.value)}
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.currency ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          >
            {CURRENCIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          {errors.currency && <p className="mt-1 text-xs text-[#dc3545]">{errors.currency}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Pricing Model</label>
          <select
            value={pricing.pricingModel}
            onChange={(e) => updateNested("pricing.pricingModel", e.target.value)}
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            {PRICING_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Pricing Schedule Dates */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Pricing Start Date <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="date"
            value={pricing.startDate}
            onChange={(e) => updateNested("pricing.startDate", e.target.value)}
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.pricingStartDate ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.pricingStartDate && <p className="mt-1 text-xs text-[#dc3545]">{errors.pricingStartDate}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Pricing End Date <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="date"
            value={pricing.endDate}
            onChange={(e) => updateNested("pricing.endDate", e.target.value)}
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.pricingEndDate ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.pricingEndDate && <p className="mt-1 text-xs text-[#dc3545]">{errors.pricingEndDate}</p>}
        </div>
      </div>

      {/* Pricing Tiers */}
      <div>
        {errors.pricingSchedule && (
          <p className="mb-2 text-xs text-[#dc3545]">{errors.pricingSchedule}</p>
        )}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[#1e293b]">Pricing Tiers</h3>
          <button
            onClick={addTier}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#044b3b] bg-[#f0fdf4] rounded-md hover:bg-[#dcfce7] transition-colors"
          >
            <Plus size={12} />
            Add Tier
          </button>
        </div>

        <div className="space-y-3">
          {pricing.tiers.map((tier, index) => (
            <div key={index} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end p-4 bg-[#f8fafc] rounded-lg border border-[#eaeaea]">
              <div className="sm:col-span-3">
                <label className="block text-xs text-[#64748b] mb-1">Tier Name</label>
                <input
                  type="text"
                  value={tier.name}
                  onChange={(e) => updateTier(index, "name", e.target.value)}
                  placeholder="e.g., Adult"
                  className="w-full px-3 py-2 border border-[#eaeaea] rounded-md text-sm text-[#1e293b] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                />
              </div>
              <div className="sm:col-span-3">
                <label className="block text-xs text-[#64748b] mb-1">Price</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e] text-sm">$</span>
                  <input
                    type="number"
                    value={tier.price}
                    onChange={(e) => updateTier(index, "price", e.target.value === "" ? "" : Number(e.target.value))}
                    min="0"
                    step="0.01"
                    className="w-full pl-7 pr-3 py-2 border border-[#eaeaea] rounded-md text-sm text-[#1e293b] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#64748b] mb-1">Min Age</label>
                <input
                  type="number"
                  value={tier.minAge}
                  onChange={(e) => updateTier(index, "minAge", Number(e.target.value))}
                  min="0"
                  className="w-full px-3 py-2 border border-[#eaeaea] rounded-md text-sm text-[#1e293b] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#64748b] mb-1">Max Age</label>
                <input
                  type="number"
                  value={tier.maxAge}
                  onChange={(e) => updateTier(index, "maxAge", Number(e.target.value))}
                  min="0"
                  className="w-full px-3 py-2 border border-[#eaeaea] rounded-md text-sm text-[#1e293b] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                />
              </div>
              <div className="sm:col-span-2 flex justify-end">
                {pricing.tiers.length > 1 && (
                  <button
                    onClick={() => removeTier(index)}
                    className="p-2 text-[#9e9e9e] hover:text-[#dc3545] transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Taxes & Fees */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Taxes (%)</label>
          <div className="relative">
            <input
              type="number"
              value={pricing.taxes}
              onChange={(e) => updateNested("pricing.taxes", e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="0"
              min="0"
              max="100"
              className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
            <Percent size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Additional Fees</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e] text-sm">$</span>
            <input
              type="number"
              value={pricing.fees}
              onChange={(e) => updateNested("pricing.fees", e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full pl-8 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Commission Rate (%)</label>
          <div className="relative">
            <input
              type="number"
              value={pricing.commissionRate}
              onChange={(e) => updateNested("pricing.commissionRate", Number(e.target.value))}
              placeholder="15"
              min="0"
              max="100"
              className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
            <Percent size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
          </div>
        </div>
      </div>

      {/* Cancellation Policy */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">Cancellation Policy</label>
        <select
          value={product.cancellationPolicy}
          onChange={(e) => updateProduct({ cancellationPolicy: e.target.value })}
          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        >
          {CANCELLATION_POLICIES.map((policy) => (
            <option key={policy.value} value={policy.value}>{policy.label}</option>
          ))}
        </select>
      </div>

      {/* Refund Rules */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">Additional Refund Rules</label>
        <textarea
          value={product.refundRules}
          onChange={(e) => updateProduct({ refundRules: e.target.value })}
          rows={3}
          placeholder="Any specific refund conditions or exceptions..."
          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
        />
      </div>
    </div>
  );
}
