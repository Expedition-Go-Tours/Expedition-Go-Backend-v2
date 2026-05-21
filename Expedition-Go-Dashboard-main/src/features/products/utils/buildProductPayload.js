/**
 * Transforms the flat product builder state into the nested API schema.
 * Matches the backend's `createTour` controller exactly.
 * Only sends fields the backend reads from req.body.
 */
export const buildProductPayload = (product) => {
  // Convert duration to minutes
  let durationMinutes = Number(product.duration) || 0;
  if (product.durationUnit === "hours") {
    durationMinutes = durationMinutes * 60;
  } else if (product.durationUnit === "days") {
    durationMinutes = durationMinutes * 24 * 60;
  } else if (product.durationUnit === "weeks") {
    durationMinutes = durationMinutes * 7 * 24 * 60;
  }

  // Extract photo URLs
  const photoUrls = (product.photos || [])
    .map((p) => (typeof p === "string" ? p : p?.url))
    .filter(Boolean);

  // Build age groups from pricing tiers
  const ageGroups = (product.pricing?.tiers || []).map((tier) => ({
    label: tier.name,
    minAge: tier.minAge,
    maxAge: tier.maxAge,
  }));

  // Build prices for pricing schedule
  const prices = (product.pricing?.tiers || []).map((tier) => ({
    ageGroup: tier.name,
    retailPrice: Number(tier.price) || 0,
  }));

  // Build transport mode object
  const transportMode = {};
  if (product.tourTransportationModes?.length) {
    transportMode.land = product.tourTransportationModes.filter((m) =>
      [
        "4WD",
        "ATV",
        "Bus",
        "Car",
        "Funicular",
        "Horse",
        "Minivan",
        "Motorcycle",
        "Rickshaw",
        "Segway",
        "Subway",
        "Train",
        "Tram",
        "Trolley",
        "Walking",
      ].includes(m),
    );
    transportMode.air = product.tourTransportationModes.filter((m) =>
      ["Plane", "Helicopter"].includes(m),
    );
  }

  // Backend createTour reads ONLY these fields from req.body:
  // title, description, categorization, theme, productContent,
  // schedulesAndPricing, bookingAndTickets, photos, coverPhoto,
  // tags, status, latitude, longitude
  const payload = {
    title: product.title || "",
    description: product.description || "",
    status: (product.status || "draft").toUpperCase(),
    tags: product.tags || [],
    photos: photoUrls,
    coverPhoto:
      product.heroImage || (photoUrls.length > 0 ? photoUrls[0] : null),
    latitude: product.latitude || null,
    longitude: product.longitude || null,

    // Nested: categorization (backend extracts category, subcategory,
    // activityType, difficulty, durationMinutes from here)
    categorization: {
      category: product.category || "",
      subcategory: product.subcategory || "",
      activityType: product.activityType || "Guided Tour",
      difficulty: product.difficulty || "Easy",
      duration: {
        hours:
          product.durationUnit === "hours" ? Number(product.duration) || 0 : undefined,
        days:
          product.durationUnit === "days" ? Number(product.duration) || 0 : undefined,
        minutes: durationMinutes,
      },
      groupSize: {
        min: product.bookingRules?.minGroupSize ?? 1,
        max: product.bookingRules?.maxGroupSize ?? 20,
      },
      transportMode,
    },

    // Nested: theme (backend extracts primaryTheme from here)
    theme: {
      primary: product.primaryTheme || product.theme || "",
      secondary: product.secondaryThemes || [],
      tags: product.tags || [],
    },

    // Nested: productContent (backend extracts city, country, region
    // from productContent.location)
    productContent: {
      highlights: product.content?.highlights || [],
      included: product.content?.included || [],
      excluded: product.content?.excluded || [],
      whatToBring: product.content?.whatToBring || [],
      itinerary: product.content?.itinerary || "",
      meetingInstructions: product.content?.meetingInstructions || "",
      additionalInfo: product.content?.additionalInfo || "",
      uniqueSellingPoints: product.content?.uniqueSellingPoints || "",
      travelerRequirements: product.content?.travelerRequirements || "",
      languages: product.content?.languages || ["English"],
      location: {
        city: product.city || "",
        country: product.country || "",
        region: product.region || "",
      },
    },

    // Nested: schedulesAndPricing
    // Backend validatePricing expects:
    // schedulesAndPricing.pricingSchedules.currency
    // schedulesAndPricing.pricingSchedules.schedules (array)
    schedulesAndPricing: {
      travelerDetails: {
        pricingModel: product.pricing?.pricingModel || "perPerson",
        maxTravelersPerBooking: product.bookingRules?.maxGroupSize ?? 20,
        ageGroups,
      },
      pricingSchedules: {
        currency: product.pricing?.currency || "USD",
        schedules: [
          {
            startDate:
              product.pricing?.startDate ||
              new Date().toISOString().split("T")[0],
            endDate:
              product.pricing?.endDate ||
              new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
                .toISOString()
                .split("T")[0],
            prices,
          },
        ],
      },
      operatingDays: product.schedule?.operatingDays || [],
      timeSlots: product.schedule?.timeSlots || [],
      capacityPerSlot: product.schedule?.capacityPerSlot ?? 20,
    },

    // Nested: bookingAndTickets
    bookingAndTickets: {
      instantBooking: product.bookingRules?.instantBooking ?? false,
      minAdvanceBookingHours:
        product.bookingRules?.minAdvanceBookingHours ?? 48,
      cancellationPolicy: {
        type: product.cancellationPolicy || "flexible",
        cutoffHours: product.schedule?.bookingCutoffHours ?? 24,
        refundPercentage: product.bookingRules?.refundPercentage ?? 100,
      },
      meetingPoint: {
        name: product.bookingRules?.meetingPoint || "",
        address: product.bookingRules?.meetingPointAddress || "",
        coordinates: {
          lat: product.bookingRules?.meetingPointLat || null,
          lng: product.bookingRules?.meetingPointLng || null,
        },
      },
      pickupAvailable: product.bookingRules?.pickupAvailable ?? false,
      pickupDetails: product.bookingRules?.pickupDetails || "",
      refundRules: product.refundRules || "",
    },
  };

  return payload;
};

export default buildProductPayload;
