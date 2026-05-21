import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";
import LocationAutocomplete from "@/components/shared/LocationAutocomplete";

const CATEGORIES = [
  { value: "safari", label: "Safari" },
  { value: "beach", label: "Beach & Island" },
  { value: "adventure", label: "Adventure" },
  { value: "cultural", label: "Cultural" },
  { value: "city", label: "City Tour" },
  { value: "wildlife", label: "Wildlife" },
  { value: "trekking", label: "Trekking & Hiking" },
  { value: "luxury", label: "Luxury" },
];

const THEMES = [
  { value: "family", label: "Family Friendly" },
  { value: "romantic", label: "Romantic" },
  { value: "solo", label: "Solo Traveler" },
  { value: "group", label: "Group Tour" },
  { value: "photography", label: "Photography" },
  { value: "luxury", label: "Luxury Experience" },
  { value: "budget", label: "Budget Friendly" },
];

const DIFFICULTIES = [
  { value: "easy", label: "Easy" },
  { value: "moderate", label: "Moderate" },
  { value: "challenging", label: "Challenging" },
  { value: "extreme", label: "Extreme" },
];

const ACTIVITY_TYPES = [
  "Guided Tour",
  "Self-Guided Tour",
  "Private Tour",
  "Group Tour",
  "Adventure Tour",
  "Cultural Experience",
  "Food & Wine Tour",
  "Wildlife Safari",
  "City Tour",
  "Walking Tour",
];

export default function ProductBasicsStep() {
  const { product, errors, updateProduct } = useProductBuilderStore();

  const handleChange = (field, value) => {
    updateProduct({ [field]: value });
  };

  const handleLocationSelect = (result) => {
    updateProduct({
      city: result.city || "",
      country: result.country || "",
      region: result.region || "",
      latitude: result.latitude,
      longitude: result.longitude,
    });
  };

  return (
    <div className="space-y-6">
      {/* Location Autocomplete */}
      <LocationAutocomplete onSelect={handleLocationSelect} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Title */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Product Title <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="text"
            value={product.title}
            onChange={(e) => handleChange("title", e.target.value)}
            placeholder="e.g., Serengeti Safari Adventure"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.title ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.title && <p className="mt-1 text-xs text-[#dc3545]">{errors.title}</p>}
        </div>

        {/* Slug */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            URL Slug
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e] text-sm">/tours/</span>
            <input
              type="text"
              value={product.slug}
              onChange={(e) => handleChange("slug", e.target.value)}
              placeholder="serengeti-safari-adventure"
              className="w-full pl-14 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Category <span className="text-[#dc3545]">*</span>
          </label>
          <select
            value={product.category}
            onChange={(e) => handleChange("category", e.target.value)}
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.category ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          >
            <option value="">Select a category</option>
            {CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value}>{cat.label}</option>
            ))}
          </select>
          {errors.category && <p className="mt-1 text-xs text-[#dc3545]">{errors.category}</p>}
        </div>

        {/* Theme */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Theme</label>
          <select
            value={product.theme}
            onChange={(e) => handleChange("theme", e.target.value)}
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            <option value="">Select a theme</option>
            {THEMES.map((theme) => (
              <option key={theme.value} value={theme.value}>{theme.label}</option>
            ))}
          </select>
        </div>

        {/* Duration */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Duration <span className="text-[#dc3545]">*</span>
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={product.duration}
              onChange={(e) => handleChange("duration", e.target.value)}
              placeholder="3"
              className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
                errors.duration ? "border-[#dc3545]" : "border-[#eaeaea]"
              }`}
            />
            <select
              value={product.durationUnit}
              onChange={(e) => handleChange("durationUnit", e.target.value)}
              className="w-32 px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
            </select>
          </div>
          {errors.duration && <p className="mt-1 text-xs text-[#dc3545]">{errors.duration}</p>}
        </div>

        {/* Difficulty */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Difficulty Level</label>
          <select
            value={product.difficulty}
            onChange={(e) => handleChange("difficulty", e.target.value)}
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            <option value="">Select difficulty</option>
            {DIFFICULTIES.map((diff) => (
              <option key={diff.value} value={diff.value}>{diff.label}</option>
            ))}
          </select>
        </div>

        {/* Subcategory */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Subcategory <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="text"
            value={product.subcategory}
            onChange={(e) => handleChange("subcategory", e.target.value)}
            placeholder="e.g., Walking Tours"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.subcategory ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.subcategory && <p className="mt-1 text-xs text-[#dc3545]">{errors.subcategory}</p>}
        </div>

        {/* Activity Type */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Activity Type <span className="text-[#dc3545]">*</span>
          </label>
          <select
            value={product.activityType}
            onChange={(e) => handleChange("activityType", e.target.value)}
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.activityType ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          >
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          {errors.activityType && <p className="mt-1 text-xs text-[#dc3545]">{errors.activityType}</p>}
        </div>

        {/* Primary Theme */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Primary Theme</label>
          <input
            type="text"
            value={product.primaryTheme}
            onChange={(e) => handleChange("primaryTheme", e.target.value)}
            placeholder="e.g., Nature & Parks"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>

        {/* Secondary Themes */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Secondary Themes</label>
          <input
            type="text"
            value={product.secondaryThemes.join(", ")}
            onChange={(e) => handleChange("secondaryThemes", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
            placeholder="History, Photography (comma separated)"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>

        {/* City */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            City <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="text"
            value={product.city}
            onChange={(e) => handleChange("city", e.target.value)}
            placeholder="e.g., New York"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.city ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.city && <p className="mt-1 text-xs text-[#dc3545]">{errors.city}</p>}
        </div>

        {/* Country */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Country <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="text"
            value={product.country}
            onChange={(e) => handleChange("country", e.target.value)}
            placeholder="e.g., USA"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.country ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.country && <p className="mt-1 text-xs text-[#dc3545]">{errors.country}</p>}
        </div>

        {/* Region */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Region</label>
          <input
            type="text"
            value={product.region}
            onChange={(e) => handleChange("region", e.target.value)}
            placeholder="e.g., Western Cape"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>

        {/* Latitude / Longitude */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Latitude</label>
          <input
            type="number"
            step="any"
            value={product.latitude ?? ""}
            onChange={(e) => handleChange("latitude", e.target.value === "" ? null : Number(e.target.value))}
            placeholder="e.g., -33.9249"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.latitude ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.latitude && <p className="mt-1 text-xs text-[#dc3545]">{errors.latitude}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Longitude</label>
          <input
            type="number"
            step="any"
            value={product.longitude ?? ""}
            onChange={(e) => handleChange("longitude", e.target.value === "" ? null : Number(e.target.value))}
            placeholder="e.g., 18.4241"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.longitude ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.longitude && <p className="mt-1 text-xs text-[#dc3545]">{errors.longitude}</p>}
        </div>

        {/* Meta Title */}
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">
            Meta Title <span className="text-[#dc3545]">*</span>
          </label>
          <input
            type="text"
            value={product.metaTitle}
            onChange={(e) => handleChange("metaTitle", e.target.value)}
            placeholder="SEO title for search engines"
            className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] ${
              errors.metaTitle ? "border-[#dc3545]" : "border-[#eaeaea]"
            }`}
          />
          {errors.metaTitle && <p className="mt-1 text-xs text-[#dc3545]">{errors.metaTitle}</p>}
        </div>

        {/* Meta Description */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Meta Description</label>
          <textarea
            value={product.metaDescription}
            onChange={(e) => handleChange("metaDescription", e.target.value)}
            rows={3}
            placeholder="Short description for SEO and social sharing"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
          />
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">Tags</label>
        <input
          type="text"
          value={product.tags.join(", ")}
          onChange={(e) => handleChange("tags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
          placeholder="wildlife, luxury, family-friendly (comma separated)"
          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        />
      </div>

      {/* Short Summary */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">Short Summary</label>
        <textarea
          value={product.shortSummary}
          onChange={(e) => handleChange("shortSummary", e.target.value)}
          rows={2}
          placeholder="Brief summary for listings (max 200 characters)"
          maxLength={200}
          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
        />
        <p className="text-xs text-[#9e9e9e] mt-1">{product.shortSummary?.length || 0}/200</p>
      </div>

      {/* Full Description */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">
          Full Description <span className="text-[#dc3545]">*</span>
        </label>
        <textarea
          value={product.description}
          onChange={(e) => handleChange("description", e.target.value)}
          rows={6}
          placeholder="Detailed description of the tour experience..."
          className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none ${
            errors.description ? "border-[#dc3545]" : "border-[#eaeaea]"
          }`}
        />
        {errors.description && <p className="mt-1 text-xs text-[#dc3545]">{errors.description}</p>}
      </div>
    </div>
  );
}
