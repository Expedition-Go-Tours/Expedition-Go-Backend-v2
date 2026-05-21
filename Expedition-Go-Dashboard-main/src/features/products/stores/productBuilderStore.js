import { create } from "zustand";

const STEPS = [
  { id: "type", label: "Product Type", number: 1 },
  { id: "basics", label: "Product Basics", number: 2 },
  { id: "content", label: "Product Content", number: 3 },
  { id: "photos", label: "Photos & Media", number: 4 },
  { id: "pricing", label: "Pricing & Tickets", number: 5 },
  { id: "schedule", label: "Schedule & Availability", number: 6 },
  { id: "booking", label: "Booking Rules", number: 7 },
  { id: "review", label: "Review & Submit", number: 8 },
];

const INITIAL_PRODUCT = {
  title: "",
  description: "",
  shortSummary: "",
  category: "",
  subcategory: "",
  theme: "",
  primaryTheme: "",
  secondaryThemes: [],
  tags: [],
  slug: "",
  difficulty: "",
  duration: "",
  durationUnit: "hours",
  activityType: "Guided Tour",
  productType: "",
  tourTransportationModes: [],
  tourDurationCategory: "",
  activityCategories: [],
  transportCategories: [],
  city: "",
  country: "",
  region: "",
  latitude: null,
  longitude: null,
  metaTitle: "",
  metaDescription: "",
  photos: [],
  heroImage: null,
  videoUrl: "",
  pricing: {
    basePrice: "",
    currency: "USD",
    pricingModel: "perPerson",
    startDate: "",
    endDate: "",
    tiers: [
      { name: "Adult", price: "", minAge: 18, maxAge: 64 },
      { name: "Child", price: "", minAge: 3, maxAge: 17 },
      { name: "Senior", price: "", minAge: 65, maxAge: 99 },
    ],
    taxes: "",
    fees: "",
    commissionRate: 15,
  },
  cancellationPolicy: "flexible",
  refundRules: "",
  schedule: {
    operatingDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    timeSlots: [{ startTime: "09:00", endTime: "12:00" }],
    seasonalAvailability: "all_year",
    blackoutDates: [],
    capacityPerSlot: 20,
    bookingCutoffHours: 24,
  },
  bookingRules: {
    confirmationType: "manual",
    minAdvanceBookingHours: 48,
    maxGroupSize: 20,
    minGroupSize: 1,
    meetingPoint: "",
    meetingPointAddress: "",
    meetingPointLat: null,
    meetingPointLng: null,
    instantBooking: false,
    refundPercentage: 100,
    pickupAvailable: false,
    pickupDetails: "",
    inclusions: [],
    exclusions: [],
  },
  content: {
    itinerary: "",
    highlights: [],
    included: [],
    excluded: [],
    whatToBring: [],
    meetingInstructions: "",
    pickupDescription: "",
    additionalInfo: "",
    uniqueSellingPoints: "",
    travelerRequirements: "",
    languages: ["English"],
  },
  status: "draft",
  totalBookings: 0,
  totalRevenue: 0,
  averageRating: 0,
  reviewCount: 0,
  viewCount: 0,
  supplier: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const useProductBuilderStore = create((set, get) => ({
  steps: STEPS,
  currentStep: 0,
  product: { ...INITIAL_PRODUCT },
  completedSteps: [],
  isDirty: false,
  isSaving: false,
  lastSaved: null,
  errors: {},

  setStep: (step) => {
    set({ currentStep: step });
  },

  nextStep: () => {
    const { currentStep, completedSteps } = get();
    const newCompleted = [...new Set([...completedSteps, currentStep])];
    set({
      currentStep: Math.min(currentStep + 1, STEPS.length - 1),
      completedSteps: newCompleted,
    });
  },

  prevStep: () => {
    const { currentStep } = get();
    set({ currentStep: Math.max(currentStep - 1, 0) });
  },

  goToStep: (step) => {
    const { completedSteps, currentStep } = get();
    if (step <= currentStep + 1 || completedSteps.includes(step)) {
      set({ currentStep: step });
    }
  },

  updateProduct: (updates) => {
    set((state) => ({
      product: { ...state.product, ...updates },
      isDirty: true,
    }));
  },

  updateNested: (path, value) => {
    set((state) => {
      const keys = path.split(".");
      const newProduct = { ...state.product };
      let current = newProduct;
      for (let i = 0; i < keys.length - 1; i++) {
        current[keys[i]] = { ...current[keys[i]] };
        current = current[keys[i]];
      }
      current[keys[keys.length - 1]] = value;
      return { product: newProduct, isDirty: true };
    });
  },

  setSaving: (saving) => set({ isSaving: saving }),

  markSaved: () => set({ isDirty: false, lastSaved: new Date().toISOString() }),

  setErrors: (errors) => set({ errors }),

  clearErrors: () => set({ errors: {} }),

  validateStep: (stepIndex) => {
    const { product } = get();
    const errors = {};

    switch (stepIndex) {
      case 0: // Product Type
        if (!product.productType) errors.productType = "Please select a product type";
        if (product.productType === "tour") {
          if (!product.tourTransportationModes?.length) errors.tourTransportationModes = "Please select at least one transportation mode";
          if (!product.tourDurationCategory) errors.tourDurationCategory = "Please select a tour duration";
        }
        if (product.productType === "activity") {
          if (!product.activityCategories?.length) errors.activityCategories = "Please select at least one activity category";
        }
        if (product.productType === "transport") {
          if (!product.transportCategories?.length) errors.transportCategories = "Please select at least one transportation type";
        }
        break;

      case 1: // Basics
        if (!product.title?.trim()) {
          errors.title = "Title is required";
        } else if (product.title.length > 200) {
          errors.title = "Title must be less than 200 characters";
        }

        if (!product.description?.trim()) {
          errors.description = "Description is required";
        } else if (product.description.trim().length < 50) {
          errors.description = "Description must be at least 50 characters";
        } else if (product.description.length > 5000) {
          errors.description = "Description must be less than 5000 characters";
        }

        if (!product.category) errors.category = "Category is required";
        if (!product.subcategory?.trim()) errors.subcategory = "Subcategory is required";
        if (!product.activityType) errors.activityType = "Activity type is required";
        if (!product.city?.trim()) errors.city = "City is required";
        if (!product.country?.trim()) errors.country = "Country is required";
        if (!product.metaTitle?.trim()) errors.metaTitle = "Meta title is required";
        if (!product.duration) errors.duration = "Duration is required";

        // Latitude / longitude: both must be present together or neither
        const hasLat = product.latitude !== null && product.latitude !== undefined && product.latitude !== '';
        const hasLng = product.longitude !== null && product.longitude !== undefined && product.longitude !== '';
        if (hasLat !== hasLng) {
          if (hasLat) errors.longitude = "Both latitude and longitude must be provided together";
          if (hasLng) errors.latitude = "Both latitude and longitude must be provided together";
        }
        if (hasLat) {
          const lat = Number(product.latitude);
          if (Number.isNaN(lat) || lat < -90 || lat > 90) {
            errors.latitude = "Latitude must be a number between -90 and 90";
          }
        }
        if (hasLng) {
          const lng = Number(product.longitude);
          if (Number.isNaN(lng) || lng < -180 || lng > 180) {
            errors.longitude = "Longitude must be a number between -180 and 180";
          }
        }
        break;

      case 2: // Content
        if (!product.content.itinerary?.trim()) errors.itinerary = "Itinerary is required";
        if (!product.content.meetingInstructions?.trim()) errors.meetingInstructions = "Meeting instructions are required";
        if (!product.content.uniqueSellingPoints?.trim()) errors.uniqueSellingPoints = "Please describe what makes your product unique";
        if (!product.content.languages?.length) errors.languages = "At least one language is required";
        break;

      case 3: // Photos & Media
        if (!product.photos || product.photos.length === 0) {
          errors.photos = "At least one photo is required";
        } else if (product.photos.length > 20) {
          errors.photos = "Maximum 20 photos allowed";
        }
        break;

      case 4: // Pricing
        if (!product.pricing.basePrice || Number(product.pricing.basePrice) <= 0) {
          errors.basePrice = "Base price must be greater than 0";
        }
        if (!product.pricing.startDate) errors.pricingStartDate = "Pricing start date is required";
        if (!product.pricing.endDate) errors.pricingEndDate = "Pricing end date is required";
        if (!product.pricing.currency || product.pricing.currency.length !== 3) {
          errors.currency = "Valid 3-letter currency code is required (e.g. USD)";
        }
        if (!product.pricing.tiers || product.pricing.tiers.length === 0) {
          errors.pricingSchedule = "At least one pricing schedule is required";
        }
        break;

      case 5: // Schedule
        if (!product.schedule.operatingDays?.length) {
          errors.operatingDays = "At least one operating day is required";
        }
        break;

      case 6: // Booking Rules
        if (!product.bookingRules.meetingPoint?.trim()) errors.meetingPoint = "Meeting point is required";
        if (!product.bookingRules.meetingPointAddress?.trim()) errors.meetingPointAddress = "Meeting point address is required";
        break;

      default:
        break;
    }

    // Global tag validation (applies across all steps)
    if (product.tags && product.tags.length > 10) {
      errors.tags = "Maximum 10 tags allowed";
    }

    const isValid = Object.keys(errors).length === 0;
    set({ errors });
    return isValid;
  },

  reset: () => {
    set({
      currentStep: 0,
      product: { ...INITIAL_PRODUCT },
      completedSteps: [],
      isDirty: false,
      isSaving: false,
      lastSaved: null,
      errors: {},
    });
  },

  loadDraft: (draft) => {
    set({
      product: { ...INITIAL_PRODUCT, ...draft },
      isDirty: false,
    });
  },
}));
