import { MapPin, Users, Clock, Check } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

const CONFIRMATION_TYPES = [
  { value: "instant", label: "Instant Confirmation", description: "Booking is confirmed immediately" },
  { value: "manual", label: "Manual Confirmation", description: "You review and confirm each booking" },
];

export default function ProductBookingStep() {
  const { product, errors, updateNested } = useProductBuilderStore();
  const { bookingRules } = product;

  const handleInclusionChange = (index, value) => {
    const newInclusions = [...bookingRules.inclusions];
    newInclusions[index] = value;
    updateNested("bookingRules.inclusions", newInclusions);
  };

  const addInclusion = () => {
    updateNested("bookingRules.inclusions", [...bookingRules.inclusions, ""]);
  };

  const removeInclusion = (index) => {
    const newInclusions = bookingRules.inclusions.filter((_, i) => i !== index);
    updateNested("bookingRules.inclusions", newInclusions);
  };

  const handleExclusionChange = (index, value) => {
    const newExclusions = [...bookingRules.exclusions];
    newExclusions[index] = value;
    updateNested("bookingRules.exclusions", newExclusions);
  };

  const addExclusion = () => {
    updateNested("bookingRules.exclusions", [...bookingRules.exclusions, ""]);
  };

  const removeExclusion = (index) => {
    const newExclusions = bookingRules.exclusions.filter((_, i) => i !== index);
    updateNested("bookingRules.exclusions", newExclusions);
  };

  return (
    <div className="space-y-6">
      {/* Confirmation Type */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-3">Booking Confirmation Type</label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CONFIRMATION_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => updateNested("bookingRules.confirmationType", type.value)}
              className={`p-4 rounded-lg border-2 text-left transition-colors ${
                bookingRules.confirmationType === type.value
                  ? "border-[#044b3b] bg-[#f0fdf4]"
                  : "border-[#eaeaea] hover:border-[#044b3b]/30"
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    bookingRules.confirmationType === type.value
                      ? "border-[#044b3b] bg-[#044b3b]"
                      : "border-[#eaeaea]"
                  }`}
                >
                  {bookingRules.confirmationType === type.value && <Check size={12} className="text-white" />}
                </div>
                <div>
                  <p className="text-sm font-semibold text-[#1e293b]">{type.label}</p>
                  <p className="text-xs text-[#64748b]">{type.description}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Group Size & Advance Booking */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            <span className="flex items-center gap-2">
              <Clock size={16} className="text-[#64748b]" />
              Min Advance Booking (hrs)
            </span>
          </label>
          <input
            type="number"
            value={bookingRules.minAdvanceBookingHours}
            onChange={(e) => updateNested("bookingRules.minAdvanceBookingHours", Number(e.target.value))}
            min="0"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            <span className="flex items-center gap-2">
              <Users size={16} className="text-[#64748b]" />
              Min Group Size
            </span>
          </label>
          <input
            type="number"
            value={bookingRules.minGroupSize}
            onChange={(e) => updateNested("bookingRules.minGroupSize", Number(e.target.value))}
            min="1"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            <span className="flex items-center gap-2">
              <Users size={16} className="text-[#64748b]" />
              Max Group Size
            </span>
          </label>
          <input
            type="number"
            value={bookingRules.maxGroupSize}
            onChange={(e) => updateNested("bookingRules.maxGroupSize", Number(e.target.value))}
            min="1"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Refund Percentage (%)</label>
          <input
            type="number"
            value={bookingRules.refundPercentage}
            onChange={(e) => updateNested("bookingRules.refundPercentage", Number(e.target.value))}
            min="0"
            max="100"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>
      </div>

      {/* Instant Booking Toggle */}
      <div className="flex items-center gap-3 p-4 bg-[#f8fafc] rounded-lg border border-[#eaeaea]">
        <input
          type="checkbox"
          id="instantBooking"
          checked={bookingRules.instantBooking}
          onChange={(e) => updateNested("bookingRules.instantBooking", e.target.checked)}
          className="w-5 h-5 rounded border-[#eaeaea] text-[#044b3b] focus:ring-[#044b3b]"
        />
        <label htmlFor="instantBooking" className="text-sm font-medium text-[#1e293b]">
          Enable Instant Booking
        </label>
        <span className="text-xs text-[#64748b]">Bookings are confirmed immediately without manual review</span>
      </div>

      {/* Meeting Point */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            <span className="flex items-center gap-2">
              <MapPin size={16} className="text-[#64748b]" />
              Meeting Point Name <span className="text-[#dc3545]">*</span>
            </span>
          </label>
          <input
            type="text"
            value={bookingRules.meetingPoint}
            onChange={(e) => updateNested("bookingRules.meetingPoint", e.target.value)}
            placeholder="e.g., Central Park South & 5th Avenue"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.meetingPoint ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.meetingPoint && <p className="mt-1 text-xs text-[#dc3545]">{errors.meetingPoint}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Meeting Point Address <span className="text-[#dc3545]">*</span>
          </label>
          <textarea
            value={bookingRules.meetingPointAddress}
            onChange={(e) => updateNested("bookingRules.meetingPointAddress", e.target.value)}
            rows={3}
            placeholder="Full street address..."
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none ${
              errors.meetingPointAddress ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.meetingPointAddress && <p className="mt-1 text-xs text-[#dc3545]">{errors.meetingPointAddress}</p>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-[#1e293b] mb-2">Latitude</label>
            <input
              type="number"
              step="any"
              value={bookingRules.meetingPointLat ?? ""}
              onChange={(e) => updateNested("bookingRules.meetingPointLat", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="e.g., 40.7647"
              className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1e293b] mb-2">Longitude</label>
            <input
              type="number"
              step="any"
              value={bookingRules.meetingPointLng ?? ""}
              onChange={(e) => updateNested("bookingRules.meetingPointLng", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="e.g., -73.973"
              className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>
        </div>
      </div>

      {/* Pickup */}
      <div className="space-y-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={bookingRules.pickupAvailable}
            onChange={(e) => updateNested("bookingRules.pickupAvailable", e.target.checked)}
            className="w-4 h-4 rounded border-[#eaeaea] text-[#044b3b] focus:ring-[#044b3b]"
          />
          <span className="text-sm font-medium text-[#1e293b]">Pickup Service Available</span>
        </label>

        {bookingRules.pickupAvailable && (
          <div>
            <label className="block text-xs text-[#64748b] mb-1">Pickup Details</label>
            <textarea
              value={bookingRules.pickupDetails}
              onChange={(e) => updateNested("bookingRules.pickupDetails", e.target.value)}
              rows={3}
              placeholder="Describe pickup locations, times, and any restrictions..."
              className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
            />
          </div>
        )}
      </div>

      {/* Inclusions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[#1e293b]">What's Included</h3>
          <button
            onClick={addInclusion}
            className="px-3 py-1.5 text-xs font-medium text-[#044b3b] bg-[#f0fdf4] rounded-md hover:bg-[#dcfce7] transition-colors"
          >
            + Add Item
          </button>
        </div>
        <div className="space-y-2">
          {bookingRules.inclusions.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={item}
                onChange={(e) => handleInclusionChange(index, e.target.value)}
                placeholder={`Inclusion ${index + 1}`}
                className="flex-1 px-4 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
              />
              <button
                onClick={() => removeInclusion(index)}
                className="p-2 text-[#9e9e9e] hover:text-[#dc3545] transition-colors"
              >
                ×
              </button>
            </div>
          ))}
          {bookingRules.inclusions.length === 0 && (
            <p className="text-sm text-[#64748b] italic">No inclusions added yet</p>
          )}
        </div>
      </div>

      {/* Exclusions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[#1e293b]">What's Excluded</h3>
          <button
            onClick={addExclusion}
            className="px-3 py-1.5 text-xs font-medium text-[#044b3b] bg-[#f0fdf4] rounded-md hover:bg-[#dcfce7] transition-colors"
          >
            + Add Item
          </button>
        </div>
        <div className="space-y-2">
          {bookingRules.exclusions.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={item}
                onChange={(e) => handleExclusionChange(index, e.target.value)}
                placeholder={`Exclusion ${index + 1}`}
                className="flex-1 px-4 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
              />
              <button
                onClick={() => removeExclusion(index)}
                className="p-2 text-[#9e9e9e] hover:text-[#dc3545] transition-colors"
              >
                ×
              </button>
            </div>
          ))}
          {bookingRules.exclusions.length === 0 && (
            <p className="text-sm text-[#64748b] italic">No exclusions added yet</p>
          )}
        </div>
      </div>
    </div>
  );
}
