import { useState } from "react";
import { Plus, Trash2, Globe, FileText, Star, MapPin, Check, ChevronRight, Users, Sparkles, Info } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

const LANGUAGES = [
  "English", "French", "German", "Spanish", "Italian", "Portuguese", "Dutch", "Russian",
  "Chinese", "Japanese", "Korean", "Arabic", "Swahili",
];

const CONTENT_SECTIONS = [
  { id: "meeting", label: "Meeting & pickup", icon: MapPin },
  { id: "details", label: "Tour details", icon: FileText },
  { id: "languages", label: "Languages Offered", icon: Globe },
  { id: "inclusions", label: "Inclusions & exclusions", icon: Check },
  { id: "unique", label: "What makes your product unique", icon: Sparkles },
  { id: "travelerInfo", label: "Information travelers need from you", icon: Info },
];

export default function ProductContentStep() {
  const { product, errors, updateNested } = useProductBuilderStore();
  const { content } = product;
  const [activeSection, setActiveSection] = useState("meeting");

  const handleHighlightChange = (index, value) => {
    const newHighlights = [...content.highlights];
    newHighlights[index] = value;
    updateNested("content.highlights", newHighlights);
  };

  const addHighlight = () => {
    updateNested("content.highlights", [...content.highlights, ""]);
  };

  const removeHighlight = (index) => {
    const newHighlights = content.highlights.filter((_, i) => i !== index);
    updateNested("content.highlights", newHighlights);
  };

  const toggleLanguage = (lang) => {
    const newLangs = content.languages.includes(lang)
      ? content.languages.filter((l) => l !== lang)
      : [...content.languages, lang];
    updateNested("content.languages", newLangs);
  };

  const isSectionComplete = (sectionId) => {
    switch (sectionId) {
      case "meeting":
        return !!content.meetingInstructions?.trim() && !!content.pickupDescription?.trim();
      case "details":
        return !!content.itinerary?.trim() && content.highlights.length > 0;
      case "languages":
        return content.languages?.length > 0;
      case "inclusions":
        return content.included?.length > 0 || content.excluded?.length > 0;
      case "unique":
        return !!content.uniqueSellingPoints?.trim();
      case "travelerInfo":
        return !!content.additionalInfo?.trim() || !!content.travelerRequirements?.trim() || content.whatToBring?.length > 0;
      default:
        return false;
    }
  };

  const renderSectionContent = () => {
    switch (activeSection) {
      case "meeting":
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                Meeting Point Instructions
              </label>
              <textarea
                value={content.meetingInstructions}
                onChange={(e) => updateNested("content.meetingInstructions", e.target.value)}
                rows={4}
                placeholder="Describe where and how customers will meet you or your guide..."
                className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none ${
                  errors.meetingInstructions ? "border-[#dc3545]" : "border-[#eaeaea]"
                }`}
              />
              {errors.meetingInstructions && (
                <p className="mt-1 text-xs text-[#dc3545]">{errors.meetingInstructions}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                Pickup Description
              </label>
              <textarea
                value={content.pickupDescription}
                onChange={(e) => updateNested("content.pickupDescription", e.target.value)}
                rows={4}
                placeholder="Describe pickup services, locations, and any restrictions..."
                className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
              />
            </div>
          </div>
        );

      case "details":
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                Full Itinerary
              </label>
              <textarea
                value={content.itinerary}
                onChange={(e) => updateNested("content.itinerary", e.target.value)}
                rows={6}
                placeholder="Day 1: Arrival and welcome...\nDay 2: Morning game drive..."
                className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none ${
                  errors.itinerary ? "border-[#dc3545]" : "border-[#eaeaea]"
                }`}
              />
              {errors.itinerary && (
                <p className="mt-1 text-xs text-[#dc3545]">{errors.itinerary}</p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-[#1e293b]">
                  <span className="flex items-center gap-2">
                    <Star size={16} className="text-[#64748b]" />
                    Tour Highlights
                  </span>
                </h3>
                <button
                  onClick={addHighlight}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#044b3b] bg-[#f0fdf4] rounded-md hover:bg-[#dcfce7] transition-colors"
                >
                  <Plus size={12} />
                  Add Highlight
                </button>
              </div>
              <div className="space-y-2">
                {content.highlights.map((item, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={item}
                      onChange={(e) => handleHighlightChange(index, e.target.value)}
                      placeholder={`Highlight ${index + 1}`}
                      className="flex-1 px-4 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                    />
                    <button
                      onClick={() => removeHighlight(index)}
                      className="p-2 text-[#9e9e9e] hover:text-[#dc3545] transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                {content.highlights.length === 0 && (
                  <p className="text-sm text-[#64748b] italic">No highlights added yet</p>
                )}
              </div>
            </div>
          </div>
        );

      case "languages":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-3">
                Languages Offered
              </label>
              {errors.languages && (
                <p className="mb-2 text-xs text-[#dc3545]">{errors.languages}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    onClick={() => toggleLanguage(lang)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      content.languages.includes(lang)
                        ? "bg-[#044b3b] text-white"
                        : "bg-[#f8fafc] text-[#64748b] border border-[#eaeaea] hover:bg-[#f0fdf4] hover:text-[#044b3b]"
                    }`}
                  >
                    {lang}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );

      case "inclusions":
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">
                  What's Included
                </label>
                <textarea
                  value={content.included.join("\n")}
                  onChange={(e) => updateNested("content.included", e.target.value.split("\n").filter(Boolean))}
                  rows={6}
                  placeholder="Professional guide\nTransportation\nMeals\n..."
                  className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
                />
                <p className="text-xs text-[#64748b] mt-1">Enter each item on a new line</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#1e293b] mb-2">
                  What's Excluded
                </label>
                <textarea
                  value={content.excluded.join("\n")}
                  onChange={(e) => updateNested("content.excluded", e.target.value.split("\n").filter(Boolean))}
                  rows={6}
                  placeholder="Flights\nPersonal expenses\nTravel insurance\n..."
                  className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
                />
                <p className="text-xs text-[#64748b] mt-1">Enter each item on a new line</p>
              </div>
            </div>
          </div>
        );

      case "unique":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                What makes your product unique?
              </label>
              <p className="text-xs text-[#64748b] mb-2">
                Describe what sets your experience apart from others. This will be shown prominently on your product page.
              </p>
              <textarea
                value={content.uniqueSellingPoints}
                onChange={(e) => updateNested("content.uniqueSellingPoints", e.target.value)}
                rows={6}
                placeholder="Our tour is the only one that offers..."
                className={`w-full px-4 py-2.5 border rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none ${
                  errors.uniqueSellingPoints ? "border-[#dc3545]" : "border-[#eaeaea]"
                }`}
              />
              {errors.uniqueSellingPoints && (
                <p className="mt-1 text-xs text-[#dc3545]">{errors.uniqueSellingPoints}</p>
              )}
            </div>
          </div>
        );

      case "travelerInfo":
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                What to Bring
              </label>
              <p className="text-xs text-[#64748b] mb-2">
                List items travelers should bring on the experience (one per line).
              </p>
              <textarea
                value={content.whatToBring.join("\n")}
                onChange={(e) => updateNested("content.whatToBring", e.target.value.split("\n").filter(Boolean))}
                rows={4}
                placeholder="Comfortable walking shoes\nWeather-appropriate clothing\nCamera or smartphone"
                className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                Additional Information
              </label>
              <p className="text-xs text-[#64748b] mb-2">
                Any other important information travelers should know before booking.
              </p>
              <textarea
                value={content.additionalInfo}
                onChange={(e) => updateNested("content.additionalInfo", e.target.value)}
                rows={4}
                placeholder="Minimum age requirements, physical fitness level..."
                className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1e293b] mb-2">
                Traveler Requirements
              </label>
              <p className="text-xs text-[#64748b] mb-2">
                Specific requirements or restrictions for travelers (e.g., age, physical ability, documents).
              </p>
              <textarea
                value={content.travelerRequirements}
                onChange={(e) => updateNested("content.travelerRequirements", e.target.value)}
                rows={4}
                placeholder="Minimum age: 12 years old. Moderate fitness level required..."
                className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
              />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Sidebar Navigation */}
      <div className="lg:w-72 flex-shrink-0">
        <div className="bg-white rounded-lg border border-[#eaeaea] overflow-hidden">
          <div className="px-4 py-3 bg-[#f8fafc] border-b border-[#eaeaea]">
            <h3 className="text-xs font-bold text-[#1e293b] uppercase tracking-wider">
              Product Content
            </h3>
          </div>
          <nav className="divide-y divide-[#eaeaea]">
            {CONTENT_SECTIONS.map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;
              const isComplete = isSectionComplete(section.id);
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left text-sm transition-colors ${
                    isActive
                      ? "bg-[#f0fdf4] text-[#044b3b] font-medium"
                      : "text-[#1e293b] hover:bg-[#f8fafc]"
                  }`}
                >
                  <div className={`flex-shrink-0 ${isActive ? "text-[#044b3b]" : "text-[#64748b]"}`}>
                    <Icon size={18} />
                  </div>
                  <span className="flex-1">{section.label}</span>
                  {isComplete && (
                    <Check size={16} className="text-[#00d67f] flex-shrink-0" />
                  )}
                  {!isComplete && isActive && (
                    <ChevronRight size={16} className="text-[#044b3b] flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 min-w-0">
        <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6">
          <div className="mb-4 pb-3 border-b border-[#eaeaea]">
            <h3 className="text-base font-semibold text-[#1e293b]">
              {CONTENT_SECTIONS.find((s) => s.id === activeSection)?.label}
            </h3>
          </div>
          {renderSectionContent()}
        </div>
      </div>
    </div>
  );
}
