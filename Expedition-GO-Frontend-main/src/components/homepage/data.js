export const navItems = ["Home", "Tours", "Destinations", "Experiences", "Deals", "About Us", "Contact"];

export const heroStats = [
  { value: "15K+", label: "Travellers guided", translationKey: "travellers" },
  { value: "240+", label: "Curated experiences", translationKey: "experiences" },
  { value: "4.9/5", label: "Average guest rating", translationKey: "rating" },
];

export const trustFeatures = [
  {
    title: "Instant Confirmation",
    description: "Get immediate booking confirmation",
  },
  {
    title: "Best Price Guarantee",
    description: "We match any lower price",
  },
  {
    title: "Free Cancellation",
    description: "On selected tours",
  },
  {
    title: "Trusted Operators",
    description: "Verified & quality experiences",
  },
  {
    title: "Secure Payments",
    description: "100% safe & secure checkout",
  },
  {
    title: "Real Reviews",
    description: "From real travellers like you",
  },
];

export const pickupTours = [
  {
    title: "Accra City Experience",
    duration: "6h",
    price: "$45",
    rating: "4.6",
    reviews: 230,
    image:
      "https://images.unsplash.com/photo-1601758125946-6ec2ef64daf8?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Cape Coast Castle Tour",
    duration: "6h",
    price: "$60",
    rating: "4.7",
    reviews: 410,
    image:
      "https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Kakum Canopy Walk",
    duration: "3h",
    price: "$35",
    rating: "4.8",
    reviews: 320,
    image:
      "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Volta Waterfalls Tour",
    duration: "5h",
    price: "$55",
    rating: "4.6",
    reviews: 182,
    image:
      "https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Ada Foah Beach Escape",
    duration: "5h",
    price: "$40",
    rating: "4.5",
    reviews: 124,
    image:
      "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Aburi Botanical Gardens Walk",
    duration: "4h",
    price: "$42",
    rating: "4.7",
    reviews: 168,
    image:
      "https://images.unsplash.com/photo-1473773508845-188df298d2d1?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Jamestown Lighthouse & Arts Tour",
    duration: "3.5h",
    price: "$38",
    rating: "4.6",
    reviews: 145,
    image:
      "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1200&q=80",
  },
  ...Array.from({ length: 20 }, (_, index) => ({
    title: `Signature Discovery Tour ${index + 1}`,
    duration: `${4 + (index % 5)}h`,
    price: `$${45 + index}`,
    rating: (4.5 + ((index % 5) * 0.1)).toFixed(1),
    reviews: 140 + index * 9,
    image: `https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1200&q=80&sig=pickup${index + 1}`,
  })),
];

export const destinations = [
  {
    title: "Accra",
    tours: "120+ Tours",
    region: "Greater Accra",
    image:
      "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Cape Coast",
    tours: "80+ Tours",
    region: "Central Region",
    image:
      "https://images.unsplash.com/photo-1528127269322-539801943592?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Kakum National Park",
    tours: "45+ Tours",
    region: "Central Region",
    image:
      "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Kumasi",
    tours: "70+ Tours",
    region: "Ashanti Region",
    image:
      "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Volta Region",
    tours: "60+ Tours",
    region: "Volta Region",
    image:
      "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Tamale",
    tours: "40+ Tours",
    region: "Northern Region",
    image:
      "https://images.unsplash.com/photo-1521401830884-6c03c1c87ebb?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Axim",
    tours: "35+ Tours",
    region: "Western Region",
    image:
      "https://images.unsplash.com/photo-1501959915551-4e8a04b3074d?auto=format&fit=crop&w=1200&q=80",
  },
  ...Array.from({ length: 10 }, (_, index) => {
    const regionPool = [
      "Greater Accra",
      "Central Region",
      "Eastern Region",
      "Volta Region",
      "Ashanti Region",
      "Brong Ahafo Region",
      "Western Region",
      "Upper West Region",
      "Upper East Region",
      "Northern Region",
      "Savannah Region",
      "North East Region",
      "Ahafo Region",
      "Bono Region",
    ];
    return {
      title: `Ghana Destination ${index + 1}`,
      tours: `${35 + index * 3}+ Tours`,
      region: regionPool[index % regionPool.length],
      image: `https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1200&q=80&sig=destination${index + 1}`,
    };
  }),
];

export const recommendedTours = [
  {
    title: "Full Day Accra City Tour",
    duration: "5h",
    price: "$50",
    rating: "4.7",
    reviews: 260,
    image:
      "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Cape Coast Day Trip",
    duration: "6h",
    price: "$65",
    rating: "4.8",
    reviews: 310,
    image:
      "https://images.unsplash.com/photo-1499856871958-5b9627545d1a?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Safari Adventure",
    duration: "8h",
    price: "$120",
    rating: "4.9",
    reviews: 210,
    image:
      "https://images.unsplash.com/photo-1516426122078-c23e76319801?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Weekend Beach Escape",
    duration: "4h",
    price: "$70",
    rating: "4.6",
    reviews: 180,
    image:
      "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Luxury Night Experience",
    duration: "3h",
    price: "$55",
    rating: "4.5",
    reviews: 150,
    image:
      "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Aburi and Boti Waterfalls Combo",
    duration: "7h",
    price: "$88",
    rating: "4.8",
    reviews: 196,
    image:
      "https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Ghana Street Food Discovery",
    duration: "4h",
    price: "$48",
    rating: "4.7",
    reviews: 172,
    image:
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=1200&q=80",
  },
  ...Array.from({ length: 20 }, (_, index) => ({
    title: `Recommended Explorer Tour ${index + 1}`,
    duration: `${3 + (index % 6)}h`,
    price: `$${52 + index * 2}`,
    rating: (4.6 + ((index % 4) * 0.1)).toFixed(1),
    reviews: 160 + index * 8,
    image: `https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=1200&q=80&sig=recommended${index + 1}`,
  })),
];

export const topRatedTours = [
  {
    title: "Cape Coast Castle",
    duration: "2h",
    price: "$60",
    rating: "4.8",
    reviews: 209,
    image:
      "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Elmina Castle",
    duration: "3h",
    price: "$55",
    rating: "4.7",
    reviews: 280,
    image:
      "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Kwame Nkrumah Park",
    duration: "1.5h",
    price: "$130",
    rating: "4.9",
    reviews: 380,
    image:
      "https://images.unsplash.com/photo-1505764706515-aa95265c5abc?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Ashanti Heritage Tour",
    duration: "6h",
    price: "$75",
    rating: "4.7",
    reviews: 210,
    image:
      "https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Traditional Festival",
    duration: "6h",
    price: "$50",
    rating: "4.8",
    reviews: 210,
    image:
      "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Shai Hills Wildlife & Caves",
    duration: "5h",
    price: "$68",
    rating: "4.8",
    reviews: 234,
    image:
      "https://images.unsplash.com/photo-1535941339077-2dd1c7963098?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Elmina Heritage and Fishing Harbor",
    duration: "4.5h",
    price: "$62",
    rating: "4.7",
    reviews: 201,
    image:
      "https://images.unsplash.com/photo-1446822775955-c34f483b410b?auto=format&fit=crop&w=1200&q=80",
  },
  ...Array.from({ length: 20 }, (_, index) => ({
    title: `Top Rated Experience ${index + 1}`,
    duration: `${2 + (index % 7)}h`,
    price: `$${58 + index * 2}`,
    rating: (4.7 + ((index % 3) * 0.1)).toFixed(1),
    reviews: 200 + index * 10,
    image: `https://images.unsplash.com/photo-1472396961693-142e6e269027?auto=format&fit=crop&w=1200&q=80&sig=toprated${index + 1}`,
  })),
];

export const leisureTours = [
  {
    title: "Beach Resort Day Pass",
    duration: "6h",
    price: "$60",
    rating: "4.6",
    reviews: 140,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Spa & Wellness Retreat",
    duration: "3h",
    price: "$80",
    rating: "4.7",
    reviews: 110,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1519822473471-7e1d8df8f9af?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Sunset Cruise",
    duration: "2h",
    price: "$55",
    rating: "4.6",
    reviews: 120,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Island Escape",
    duration: "5h",
    price: "$75",
    rating: "4.8",
    reviews: 90,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1439066615861-d1af74d74000?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Poolside Experience",
    duration: "4h",
    price: "$50",
    rating: "4.5",
    reviews: 80,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1519046904884-53103b34b206?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Aqua Yoga & Brunch Retreat",
    duration: "3.5h",
    price: "$65",
    rating: "4.7",
    reviews: 98,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Secluded Lagoon Kayak Escape",
    duration: "4.5h",
    price: "$72",
    rating: "4.8",
    reviews: 104,
    discount: "Likely to Sell Out",
    image:
      "https://images.unsplash.com/photo-1473116763249-2faaef81ccda?auto=format&fit=crop&w=1200&q=80",
  },
  ...Array.from({ length: 20 }, (_, index) => ({
    title: `Leisure Escape ${index + 1}`,
    duration: `${3 + (index % 5)}h`,
    price: `$${55 + index * 2}`,
    rating: (4.5 + ((index % 4) * 0.1)).toFixed(1),
    reviews: 95 + index * 7,
    discount: "Likely to Sell Out",
    image: `https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80&sig=leisure${index + 1}`,
  })),
];


export const lastMinuteDeals = [
  {
    title: "Accra City Tour",
    oldPrice: "$50",
    price: "$40",
    discount: "-20%",
    countdown: "Ends in 05:30:15",
    image:
      "https://images.unsplash.com/photo-1472396961693-142e6e269027?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Volta Region Tour",
    oldPrice: "$60",
    price: "$45",
    discount: "-25%",
    countdown: "Ends in 07:45:20",
    image:
      "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Safari Adventure",
    oldPrice: "$150",
    price: "$127",
    discount: "-15%",
    countdown: "Ends in 10:20:35",
    image:
      "https://images.unsplash.com/photo-1516426122078-c23e76319801?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Beach Escape",
    oldPrice: "$75",
    price: "$56",
    discount: "-20%",
    countdown: "Ends in 06:30:45",
    image:
      "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80",
  },
];

export const sidebarTopRated = [
  {
    title: "Cape Coast Castle",
    duration: "2h",
    price: "$60",
    rating: "4.9",
    reviews: "500+",
    image:
      "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Kakum Canopy Walk",
    duration: "3h",
    price: "$40",
    rating: "4.9",
    reviews: "420+",
    image:
      "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Safari Experience",
    duration: "8h",
    price: "$130",
    rating: "4.9",
    reviews: "380+",
    image:
      "https://images.unsplash.com/photo-1516426122078-c23e76319801?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Volta Heritage Tour",
    duration: "6h",
    price: "$75",
    rating: "4.8",
    reviews: "280+",
    image:
      "https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Mole National Park",
    duration: "10h",
    price: "$95",
    rating: "4.9",
    reviews: "350+",
    image:
      "https://images.unsplash.com/photo-1549366021-9f761d450615?auto=format&fit=crop&w=1200&q=80",
  },
  {
    title: "Wli Waterfalls Adventure",
    duration: "4h",
    price: "$55",
    rating: "4.8",
    reviews: "290+",
    image:
      "https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?auto=format&fit=crop&w=1200&q=80",
  },
];

export const paymentLogos = [
  "PayPal",
  "Mastercard",
  "Visa",
  "JCB",
  "Bancontact",
  "Local",
];

export const footerGroups = [
  {
    title: "Explore",
    links: ["Home", "Tours", "Destinations", "Experiences", "Deals", "About Us", "Contact"],
  },
  {
    title: "Support",
    links: ["Help Centre", "Contact Us", "Live Chat", "Booking Support", "Cancellation Help", "FAQ"],
  },
  {
    title: "Company",
    links: ["About Us", "Careers", "Partners", "Affiliate Program", "Press", "Investor Relations"],
  },
  {
    title: "Supplier Zone",
    links: ["List Your Tours", "Become a Tour Operator", "Supplier Dashboard", "API Access", "Agent Accounts"],
  },
  {
    title: "Follow Us",
    links: ["Instagram", "Facebook", "TikTok", "Link", "YouTube", "X"],
  },
];
