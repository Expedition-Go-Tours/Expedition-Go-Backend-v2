import { useState, useEffect, useRef } from "react";
import { Map, Waves, Bus, X, ChevronDown, HelpCircle, ChevronRight, Search } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

const PRODUCT_TYPES = [
  {
    id: "tour",
    label: "Tour",
    description: "A guided visit to one or more sites",
    icon: Map,
  },
  {
    id: "activity",
    label: "Activity",
    description: "An instructed or interactive experience",
    icon: Waves,
  },
  {
    id: "transport",
    label: "Transport",
    description: "Transferring travelers between locations, with a focus on transportation rather than sightseeing",
    icon: Bus,
  },
];

const TRANSPORTATION_MODES = [
  "4WD",
  "ATV",
  "Boat",
  "Bus",
  "Car",
  "Funicular",
  "Horse",
  "Minivan",
  "Motorcycle",
  "None",
  "Rickshaw",
  "Segway",
  "Subway",
  "Train",
  "Tram",
  "Trolley",
  "Walking",
];

const TOUR_DURATIONS = [
  { value: "one_day_or_less", label: "One day or less" },
  { value: "two_or_more_days", label: "Two or more days" },
];

const ACTIVITY_CATEGORIES = [
  {
    name: "Air Activities",
    items: ["Aerial Tours", "Hot Air Ballooning", "Helicopter Tours", "Paragliding", "Skydiving"],
  },
  {
    name: "Classes/Lessons/Workshops",
    items: ["Cooking Classes", "Art Workshops", "Photography Classes", "Dance Lessons", "Language Classes"],
  },
  {
    name: "Dining Experience",
    items: ["Food Tours", "Wine Tasting", "Dinner Cruises", "Farm-to-Table", "Street Food Tours"],
  },
  {
    name: "Fun & Games",
    items: ["Escape Rooms", "Arcade Games", "Mini Golf", "Bowling", "Laser Tag"],
  },
  {
    name: "Land & Outdoor Activities",
    items: ["Hiking", "Cycling", "Horseback Riding", "Rock Climbing", "ATV Tours"],
  },
  {
    name: "Snow Activities",
    items: ["Skiing", "Snowboarding", "Snowshoeing", "Dog Sledding", "Ice Fishing"],
  },
  {
    name: "Water Activities",
    items: ["Snorkeling", "Scuba Diving", "Kayaking", "Surfing", "Jet Skiing"],
  },
];

const TRANSPORT_CATEGORIES = [
  {
    name: "Air Transports",
    items: ["Airport Transfers", "Helicopter Transfers", "Seaplane Transfers", "Private Jet Charters"],
  },
  {
    name: "Land Transports",
    items: ["Private Car Transfers", "Shuttle Bus Services", "Train Tickets", "Limousine Services", "Motorcycle Taxis"],
  },
  {
    name: "Passes",
    items: ["City Passes", "Regional Rail Passes", "Bus Passes", "Ferry Passes", "Multi-Day Transport Passes"],
  },
  {
    name: "Water Transports",
    items: ["Ferry Transfers", "Water Taxi Services", "Private Boat Transfers", "Cruise Ship Transfers"],
  },
];

export default function ProductTypeStep() {
  const { product, errors, updateProduct } = useProductBuilderStore();
  const [transportDropdownOpen, setTransportDropdownOpen] = useState(false);
  const [activityDropdownOpen, setActivityDropdownOpen] = useState(false);
  const [transportCategoryDropdownOpen, setTransportCategoryDropdownOpen] = useState(false);
  const [activitySearch, setActivitySearch] = useState("");
  const [transportSearch, setTransportSearch] = useState("");
  const [expandedCategories, setExpandedCategories] = useState({});
  const transportRef = useRef(null);
  const activityRef = useRef(null);
  const transportCategoryRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (transportRef.current && !transportRef.current.contains(event.target)) {
        setTransportDropdownOpen(false);
      }
      if (activityRef.current && !activityRef.current.contains(event.target)) {
        setActivityDropdownOpen(false);
      }
      if (transportCategoryRef.current && !transportCategoryRef.current.contains(event.target)) {
        setTransportCategoryDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleTypeChange = (type) => {
    updateProduct({ productType: type });
  };

  const toggleTransportMode = (mode) => {
    const current = product.tourTransportationModes || [];
    const updated = current.includes(mode)
      ? current.filter((m) => m !== mode)
      : [...current, mode];
    updateProduct({ tourTransportationModes: updated });
  };

  const removeTransportMode = (mode) => {
    const current = product.tourTransportationModes || [];
    updateProduct({ tourTransportationModes: current.filter((m) => m !== mode) });
  };

  const handleDurationChange = (value) => {
    updateProduct({ tourDurationCategory: value });
  };

  const toggleActivityItem = (item) => {
    const current = product.activityCategories || [];
    const updated = current.includes(item)
      ? current.filter((i) => i !== item)
      : [...current, item];
    updateProduct({ activityCategories: updated });
  };

  const removeActivityItem = (item) => {
    const current = product.activityCategories || [];
    updateProduct({ activityCategories: current.filter((i) => i !== item) });
  };

  const toggleTransportItem = (item) => {
    const current = product.transportCategories || [];
    const updated = current.includes(item)
      ? current.filter((i) => i !== item)
      : [...current, item];
    updateProduct({ transportCategories: updated });
  };

  const removeTransportItem = (item) => {
    const current = product.transportCategories || [];
    updateProduct({ transportCategories: current.filter((i) => i !== item) });
  };

  const toggleCategoryExpand = (categoryName) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryName]: !prev[categoryName],
    }));
  };

  const filteredCategories = ACTIVITY_CATEGORIES.map((cat) => ({
    ...cat,
    items: cat.items.filter((item) =>
      item.toLowerCase().includes(activitySearch.toLowerCase())
    ),
  })).filter((cat) => cat.items.length > 0 || cat.name.toLowerCase().includes(activitySearch.toLowerCase()));

  const filteredTransportCategories = TRANSPORT_CATEGORIES.map((cat) => ({
    ...cat,
    items: cat.items.filter((item) =>
      item.toLowerCase().includes(transportSearch.toLowerCase())
    ),
  })).filter((cat) => cat.items.length > 0 || cat.name.toLowerCase().includes(transportSearch.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-[#1e293b]">
          What type of product are you creating?
        </h3>
        <p className="text-sm text-[#64748b]">
          Please choose carefully as it impacts the following sections and you won't be able to edit this later.
        </p>
      </div>

      {/* Product Type Cards */}
      <div className="space-y-4">
        {PRODUCT_TYPES.map((type) => {
          const isSelected = product.productType === type.id;
          const Icon = type.icon;
          return (
            <div
              key={type.id}
              onClick={() => handleTypeChange(type.id)}
              className={`relative flex items-start gap-4 p-4 md:p-5 rounded-lg border-2 cursor-pointer transition-all duration-200 ${
                isSelected
                  ? "border-[#044b3b] bg-[#044b3b]/[0.02]"
                  : "border-[#eaeaea] hover:border-[#cbd5e1]"
              }`}
            >
              {/* Radio indicator */}
              <div className="mt-1 flex-shrink-0">
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                    isSelected ? "border-[#044b3b]" : "border-[#cbd5e1]"
                  }`}
                >
                  {isSelected && (
                    <div className="w-2.5 h-2.5 rounded-full bg-[#044b3b]" />
                  )}
                </div>
              </div>

              {/* Icon */}
              <div className="flex-shrink-0 text-[#64748b]">
                <Icon size={32} strokeWidth={1.5} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className={`text-base font-semibold ${isSelected ? "text-[#044b3b]" : "text-[#1e293b]"}`}>
                    {type.label}
                  </h4>
                  <HelpCircle size={16} className="text-[#9e9e9e]" />
                </div>
                <p className="text-sm text-[#64748b] mt-0.5">{type.description}</p>

                {/* Conditional Tour fields */}
                {isSelected && type.id === "tour" && (
                  <div className="mt-5 space-y-5 border-t border-[#eaeaea] pt-5">
                    {/* Transportation Modes */}
                    <div ref={transportRef}>
                      <label className="flex items-center gap-1.5 text-sm font-medium text-[#1e293b] mb-2">
                        What modes of transportation are used during the tour?
                        <HelpCircle size={14} className="text-[#9e9e9e]" />
                      </label>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTransportDropdownOpen(!transportDropdownOpen);
                          }}
                          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-left bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] flex items-center justify-between min-h-[42px]"
                        >
                          <div className="flex flex-wrap gap-1.5">
                            {(product.tourTransportationModes || []).length > 0 ? (
                              (product.tourTransportationModes || []).map((mode) => (
                                <span
                                  key={mode}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#f1f5f9] text-[#1e293b] text-xs rounded border border-[#e2e8f0]"
                                >
                                  {mode}
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeTransportMode(mode);
                                    }}
                                    className="cursor-pointer hover:text-[#dc3545]"
                                  >
                                    <X size={12} />
                                  </span>
                                </span>
                              ))
                            ) : (
                              <span className="text-[#9e9e9e]">Select transportation modes</span>
                            )}
                          </div>
                          <ChevronDown size={16} className={`text-[#9e9e9e] transition-transform flex-shrink-0 ml-2 ${transportDropdownOpen ? "rotate-180" : ""}`} />
                        </button>

                        {transportDropdownOpen && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute z-10 mt-1 w-full bg-white border border-[#cbd5e1] rounded-lg shadow-xl max-h-60 overflow-y-auto p-1"
                          >
                            {TRANSPORTATION_MODES.map((mode) => (
                              <label
                                key={mode}
                                className="flex items-center gap-2 px-3 py-2 text-sm text-[#1e293b] hover:bg-[#f8fafc] rounded cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={(product.tourTransportationModes || []).includes(mode)}
                                  onChange={() => toggleTransportMode(mode)}
                                  className="w-4 h-4 rounded border-[#cbd5e1] text-[#044b3b] focus:ring-[#044b3b]"
                                />
                                {mode}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                      {errors.tourTransportationModes && (
                        <p className="mt-1 text-xs text-[#dc3545]">{errors.tourTransportationModes}</p>
                      )}
                    </div>

                    {/* Tour Duration */}
                    <div>
                      <label className="flex items-center gap-1.5 text-sm font-medium text-[#1e293b] mb-3">
                        How long is this tour?
                        <HelpCircle size={14} className="text-[#9e9e9e]" />
                      </label>
                      <div className="space-y-2">
                        {TOUR_DURATIONS.map((option) => (
                          <label
                            key={option.value}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDurationChange(option.value);
                            }}
                            className="flex items-center gap-3 cursor-pointer"
                          >
                            <div
                              className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                                product.tourDurationCategory === option.value
                                  ? "border-[#044b3b]"
                                  : "border-[#cbd5e1]"
                              }`}
                            >
                              {product.tourDurationCategory === option.value && (
                                <div className="w-2 h-2 rounded-full bg-[#044b3b]" />
                              )}
                            </div>
                            <span className="text-sm text-[#1e293b]">{option.label}</span>
                          </label>
                        ))}
                      </div>
                      {errors.tourDurationCategory && (
                        <p className="mt-1 text-xs text-[#dc3545]">{errors.tourDurationCategory}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Conditional Activity fields */}
                {isSelected && type.id === "activity" && (
                  <div className="mt-5 space-y-5 border-t border-[#eaeaea] pt-5">
                    {/* Activity Categories Dropdown */}
                    <div ref={activityRef}>
                      <label className="flex items-center gap-1.5 text-sm font-medium text-[#1e293b] mb-2">
                        What activities are included?
                        <HelpCircle size={14} className="text-[#9e9e9e]" />
                      </label>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActivityDropdownOpen(!activityDropdownOpen);
                          }}
                          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-left bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] flex items-center justify-between min-h-[42px]"
                        >
                          <div className="flex flex-wrap gap-1.5">
                            {(product.activityCategories || []).length > 0 ? (
                              (product.activityCategories || []).map((item) => (
                                <span
                                  key={item}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#f1f5f9] text-[#1e293b] text-xs rounded border border-[#e2e8f0]"
                                >
                                  {item}
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeActivityItem(item);
                                    }}
                                    className="cursor-pointer hover:text-[#dc3545]"
                                  >
                                    <X size={12} />
                                  </span>
                                </span>
                              ))
                            ) : (
                              <span className="text-[#9e9e9e]">Select one (or more)</span>
                            )}
                          </div>
                          <ChevronDown size={16} className={`text-[#9e9e9e] transition-transform flex-shrink-0 ml-2 ${activityDropdownOpen ? "rotate-180" : ""}`} />
                        </button>

                        {activityDropdownOpen && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute z-20 mt-1 w-full bg-white border border-[#cbd5e1] rounded-lg shadow-xl max-h-72 overflow-y-auto p-2"
                          >
                            {/* Search */}
                            <div className="sticky top-0 bg-white pb-2 border-b border-[#eaeaea] mb-1">
                              <div className="relative">
                                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
                                <input
                                  type="text"
                                  value={activitySearch}
                                  onChange={(e) => setActivitySearch(e.target.value)}
                                  placeholder="Search activities"
                                  className="w-full pl-8 pr-3 py-2 text-sm border border-[#eaeaea] rounded-md text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b] bg-white"
                                />
                              </div>
                            </div>

                            {/* Categories */}
                            <div className="space-y-1">
                              {filteredCategories.map((category) => (
                                <div key={category.name}>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleCategoryExpand(category.name);
                                    }}
                                    className="w-full flex items-center justify-between px-2 py-2 text-sm text-[#1e293b] hover:bg-[#f8fafc] rounded-md transition-colors"
                                  >
                                    <span className="font-medium">{category.name}</span>
                                    <ChevronRight
                                      size={14}
                                      className={`text-[#9e9e9e] transition-transform ${expandedCategories[category.name] ? "rotate-90" : ""}`}
                                    />
                                  </button>
                                  {expandedCategories[category.name] && (
                                    <div className="ml-2 pl-2 border-l border-[#eaeaea] space-y-0.5">
                                      {category.items.map((item) => (
                                        <label
                                          key={item}
                                          className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#1e293b] hover:bg-[#f8fafc] rounded cursor-pointer"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={(product.activityCategories || []).includes(item)}
                                            onChange={() => toggleActivityItem(item)}
                                            className="w-4 h-4 rounded border-[#cbd5e1] text-[#044b3b] focus:ring-[#044b3b]"
                                          />
                                          {item}
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {filteredCategories.length === 0 && (
                                <p className="px-2 py-3 text-sm text-[#9e9e9e] text-center">
                                  No activities found
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      {errors.activityCategories && (
                        <p className="mt-1 text-xs text-[#dc3545]">{errors.activityCategories}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Conditional Transport fields */}
                {isSelected && type.id === "transport" && (
                  <div className="mt-5 space-y-5 border-t border-[#eaeaea] pt-5">
                    {/* Transport Categories Dropdown */}
                    <div ref={transportCategoryRef}>
                      <label className="flex items-center gap-1.5 text-sm font-medium text-[#1e293b] mb-2">
                        What type of transportation service are you providing?
                        <HelpCircle size={14} className="text-[#9e9e9e]" />
                      </label>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTransportCategoryDropdownOpen(!transportCategoryDropdownOpen);
                          }}
                          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-left bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] flex items-center justify-between min-h-[42px]"
                        >
                          <div className="flex flex-wrap gap-1.5">
                            {(product.transportCategories || []).length > 0 ? (
                              (product.transportCategories || []).map((item) => (
                                <span
                                  key={item}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#f1f5f9] text-[#1e293b] text-xs rounded border border-[#e2e8f0]"
                                >
                                  {item}
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeTransportItem(item);
                                    }}
                                    className="cursor-pointer hover:text-[#dc3545]"
                                  >
                                    <X size={12} />
                                  </span>
                                </span>
                              ))
                            ) : (
                              <span className="text-[#9e9e9e]">Select one (or more)</span>
                            )}
                          </div>
                          <ChevronDown size={16} className={`text-[#9e9e9e] transition-transform flex-shrink-0 ml-2 ${transportCategoryDropdownOpen ? "rotate-180" : ""}`} />
                        </button>

                        {transportCategoryDropdownOpen && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute z-20 mt-1 w-full bg-white border border-[#cbd5e1] rounded-lg shadow-xl max-h-72 overflow-y-auto p-2"
                          >
                            {/* Search */}
                            <div className="sticky top-0 bg-white pb-2 border-b border-[#eaeaea] mb-1">
                              <div className="relative">
                                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
                                <input
                                  type="text"
                                  value={transportSearch}
                                  onChange={(e) => setTransportSearch(e.target.value)}
                                  placeholder="Search transportation types"
                                  className="w-full pl-8 pr-3 py-2 text-sm border border-[#eaeaea] rounded-md text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b] bg-white"
                                />
                              </div>
                            </div>

                            {/* Categories */}
                            <div className="space-y-1">
                              {filteredTransportCategories.map((category) => (
                                <div key={category.name}>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleCategoryExpand(category.name);
                                    }}
                                    className="w-full flex items-center justify-between px-2 py-2 text-sm text-[#1e293b] hover:bg-[#f8fafc] rounded-md transition-colors"
                                  >
                                    <span className="font-medium">{category.name}</span>
                                    <ChevronRight
                                      size={14}
                                      className={`text-[#9e9e9e] transition-transform ${expandedCategories[category.name] ? "rotate-90" : ""}`}
                                    />
                                  </button>
                                  {expandedCategories[category.name] && (
                                    <div className="ml-2 pl-2 border-l border-[#eaeaea] space-y-0.5">
                                      {category.items.map((item) => (
                                        <label
                                          key={item}
                                          className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#1e293b] hover:bg-[#f8fafc] rounded cursor-pointer"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={(product.transportCategories || []).includes(item)}
                                            onChange={() => toggleTransportItem(item)}
                                            className="w-4 h-4 rounded border-[#cbd5e1] text-[#044b3b] focus:ring-[#044b3b]"
                                          />
                                          {item}
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {filteredTransportCategories.length === 0 && (
                                <p className="px-2 py-3 text-sm text-[#9e9e9e] text-center">
                                  No transportation types found
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      {errors.transportCategories && (
                        <p className="mt-1 text-xs text-[#dc3545]">{errors.transportCategories}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {errors.productType && (
        <p className="text-xs text-[#dc3545]">{errors.productType}</p>
      )}
    </div>
  );
}
