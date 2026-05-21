import { useState } from "react";
import {
  Star,
  Check,
  X,
  Flag,
  MessageSquare,
  Eye,
  Filter,
  Search,
  ChevronDown,
  ThumbsUp,
  ThumbsDown,
  User,
} from "lucide-react";
import StatusBadge from "@/components/shared/StatusBadge";
import { formatDate, formatDateTime } from "@/lib/utils";

const REVIEW_TABS = [
  { key: "pending", label: "Pending Approval", count: 12 },
  { key: "approved", label: "Approved", count: 234 },
  { key: "flagged", label: "Flagged", count: 5 },
  { key: "replied", label: "Replied", count: 89 },
  { key: "unreplied", label: "Unreplied", count: 45 },
];

// Mock reviews
const MOCK_REVIEWS = [
  {
    id: "REV-001",
    tourName: "Serengeti Safari Adventure",
    customerName: "Sarah Johnson",
    customerEmail: "sarah@example.com",
    rating: 5,
    title: "Absolutely incredible experience!",
    comment: "The safari was everything we dreamed of and more. Our guide was incredibly knowledgeable and spotted animals we never would have seen on our own. The accommodations were luxurious and the food was amazing. Highly recommend!",
    date: "2026-05-15",
    status: "pending",
    photos: 3,
    helpful: 24,
    tourId: "1",
    bookingId: "BK-2026-0002",
    supplierResponse: null,
  },
  {
    id: "REV-002",
    tourName: "Kilimanjaro Trek",
    customerName: "Michael Brown",
    customerEmail: "michael@example.com",
    rating: 4,
    title: "Challenging but rewarding",
    comment: "The trek was very challenging but the views from the summit made it all worthwhile. The guides were professional and safety-conscious. The only reason I'm giving 4 stars instead of 5 is because the equipment provided could have been better quality.",
    date: "2026-05-14",
    status: "approved",
    photos: 0,
    helpful: 18,
    tourId: "3",
    bookingId: "BK-2026-0003",
    supplierResponse: "Thank you for your feedback, Michael! We're constantly upgrading our equipment and have recently invested in new gear.",
  },
  {
    id: "REV-003",
    tourName: "Zanzibar Beach Escape",
    customerName: "Emily Davis",
    customerEmail: "emily@example.com",
    rating: 2,
    title: "Not what was advertised",
    comment: "The beach was overcrowded and the resort was not as described in the photos. The food options were very limited. I expected much better for the price paid. Very disappointed.",
    date: "2026-05-13",
    status: "flagged",
    photos: 2,
    helpful: 45,
    tourId: "2",
    bookingId: "BK-2026-0004",
    supplierResponse: null,
    flagReason: "Customer complaint about misrepresentation",
  },
  {
    id: "REV-004",
    tourName: "Masai Mara Wildlife Tour",
    customerName: "Robert Wilson",
    customerEmail: "robert@example.com",
    rating: 5,
    title: "Best trip of my life",
    comment: "Every moment was magical. We saw the Big Five on our first day! The guides were passionate about conservation and taught us so much. The camp was comfortable and the sunsets were breathtaking.",
    date: "2026-05-12",
    status: "approved",
    photos: 5,
    helpful: 67,
    tourId: "4",
    bookingId: "BK-2026-0005",
    supplierResponse: null,
  },
  {
    id: "REV-005",
    tourName: "Victoria Falls Expedition",
    customerName: "Lisa Anderson",
    customerEmail: "lisa@example.com",
    rating: 3,
    title: "Good but overpriced",
    comment: "The falls are spectacular no doubt, but I felt the tour was overpriced for what was included. The guide was good but rushed us through some sections.",
    date: "2026-05-10",
    status: "pending",
    photos: 1,
    helpful: 12,
    tourId: "5",
    bookingId: "BK-2026-0006",
    supplierResponse: null,
  },
  {
    id: "REV-006",
    tourName: "Serengeti Safari Adventure",
    customerName: "James Thomas",
    customerEmail: "james@example.com",
    rating: 1,
    title: "Terrible experience",
    comment: "The vehicle broke down twice during the safari. We missed the migration viewing. The guide was unprofessional and rude. I want a full refund.",
    date: "2026-05-08",
    status: "flagged",
    photos: 0,
    helpful: 8,
    tourId: "1",
    bookingId: "BK-2026-0009",
    supplierResponse: null,
    flagReason: "Vehicle breakdown and refund request",
  },
];

// Rating Stars component
function RatingStars({ rating, size = 16 }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={size}
          className={star <= rating ? "text-[#ffc400] fill-[#ffc400]" : "text-[#eaeaea]"}
        />
      ))}
    </div>
  );
}

// Review Card component
function ReviewCard({ review, onApprove, onReject, onFlag, onView }) {
  const [showResponse, setShowResponse] = useState(false);
  const [responseText, setResponseText] = useState("");

  return (
    <div className="bg-white rounded-lg border border-[#eaeaea] p-5 hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#044b3b] flex items-center justify-center text-white font-medium text-sm flex-shrink-0">
            {review.customerName.charAt(0)}
          </div>
          <div>
            <p className="text-sm font-medium text-[#1e293b]">{review.customerName}</p>
            <p className="text-xs text-[#64748b]">{review.customerEmail}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            status={
              review.status === "approved"
                ? "CONFIRMED"
                : review.status === "flagged"
                ? "REFUND_REQUEST"
                : review.status === "pending"
                ? "AWAITING_CONFIRMATION"
                : "AMENDED"
            }
            label={review.status}
            size="sm"
          />
        </div>
      </div>

      {/* Tour & Rating */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 mb-3">
        <div>
          <p className="text-xs text-[#64748b] uppercase tracking-wider">Tour</p>
          <p className="text-sm font-medium text-[#044b3b]">{review.tourName}</p>
        </div>
        <div className="sm:text-right">
          <RatingStars rating={review.rating} />
          <p className="text-xs text-[#64748b] mt-0.5">{formatDate(review.date)}</p>
        </div>
      </div>

      {/* Review Content */}
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-[#1e293b] mb-1">{review.title}</h4>
        <p className="text-sm text-[#64748b] leading-relaxed">{review.comment}</p>
      </div>

      {/* Photos indicator */}
      {review.photos > 0 && (
        <div className="flex items-center gap-2 mb-3 text-xs text-[#64748b]">
          <span className="bg-[#f8fafc] px-2 py-1 rounded-md">{review.photos} photos attached</span>
        </div>
      )}

      {/* Flag reason */}
      {review.flagReason && (
        <div className="bg-[#fffbeb] border border-[#ffc400] rounded-md p-3 mb-3">
          <p className="text-xs font-medium text-[#b45309] flex items-center gap-1">
            <Flag size={12} />
            Flagged: {review.flagReason}
          </p>
        </div>
      )}

      {/* Supplier Response */}
      {review.supplierResponse && (
        <div className="bg-[#f8fafc] rounded-md p-3 mb-3">
          <p className="text-xs font-semibold text-[#1e293b] mb-1">Supplier Response:</p>
          <p className="text-sm text-[#64748b]">{review.supplierResponse}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pt-3 border-t border-[#eaeaea] gap-3 sm:gap-0">
        <div className="flex items-center gap-4 text-sm text-[#64748b]">
          <span className="flex items-center gap-1">
            <ThumbsUp size={14} />
            {review.helpful} helpful
          </span>
          <span className="text-xs">Booking: {review.bookingId}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {review.status === "pending" && (
            <>
              <button
                onClick={() => onApprove?.(review.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ebfcf5] text-[#047857] rounded-md text-xs font-medium hover:bg-[#d1fae5] transition-colors"
              >
                <Check size={14} />
                Approve
              </button>
              <button
                onClick={() => onReject?.(review.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ffebeb] text-[#b91c1c] rounded-md text-xs font-medium hover:bg-[#fee2e2] transition-colors"
              >
                <X size={14} />
                Reject
              </button>
            </>
          )}

          {review.status === "flagged" && (
            <button
              onClick={() => onApprove?.(review.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#ebfcf5] text-[#047857] rounded-md text-xs font-medium hover:bg-[#d1fae5] transition-colors"
            >
              <Check size={14} />
              Resolve
            </button>
          )}

          {review.status === "approved" && !review.supplierResponse && (
            <button
              onClick={() => setShowResponse(!showResponse)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#f8fafc] text-[#64748b] rounded-md text-xs font-medium hover:bg-[#f0fdf4] hover:text-[#044b3b] transition-colors"
            >
              <MessageSquare size={14} />
              Respond
            </button>
          )}

          <button
            onClick={() => onFlag?.(review.id)}
            className="p-1.5 text-[#9e9e9e] hover:text-[#ffc400] transition-colors"
            title="Flag review"
          >
            <Flag size={14} />
          </button>

          <button
            onClick={() => onView?.(review)}
            className="p-1.5 text-[#9e9e9e] hover:text-[#044b3b] transition-colors"
            title="View details"
          >
            <Eye size={14} />
          </button>
        </div>
      </div>

      {/* Response Input */}
      {showResponse && (
        <div className="mt-3 pt-3 border-t border-[#eaeaea]">
          <textarea
            value={responseText}
            onChange={(e) => setResponseText(e.target.value)}
            placeholder="Write a response to this review..."
            rows={3}
            className="w-full px-3 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b] resize-none"
          />
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              onClick={() => setShowResponse(false)}
              className="px-3 py-1.5 text-xs text-[#64748b] hover:text-[#1e293b] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setShowResponse(false);
                setResponseText("");
              }}
              className="px-3 py-1.5 bg-[#044b3b] text-white rounded-md text-xs font-medium hover:bg-[#033629] transition-colors"
            >
              Post Response
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const [activeTab, setActiveTab] = useState("pending");
  const [search, setSearch] = useState("");
  const [ratingFilter, setRatingFilter] = useState("");

  const filteredReviews = MOCK_REVIEWS.filter((review) => {
    const matchesTab = review.status === activeTab;
    const matchesSearch =
      !search ||
      review.customerName.toLowerCase().includes(search.toLowerCase()) ||
      review.tourName.toLowerCase().includes(search.toLowerCase()) ||
      review.comment.toLowerCase().includes(search.toLowerCase());
    const matchesRating = !ratingFilter || review.rating === Number(ratingFilter);

    // Handle special tabs
    if (activeTab === "replied") return review.supplierResponse && matchesSearch && matchesRating;
    if (activeTab === "unreplied") return !review.supplierResponse && review.status === "approved" && matchesSearch && matchesRating;

    return matchesTab && matchesSearch && matchesRating;
  });

  const handleApprove = (id) => {
    console.log("Approve review:", id);
  };

  const handleReject = (id) => {
    console.log("Reject review:", id);
  };

  const handleFlag = (id) => {
    console.log("Flag review:", id);
  };

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Reviews</h1>
          <p className="text-sm text-[#64748b] mt-1">Moderate and manage customer reviews</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
            <input
              type="text"
              placeholder="Search reviews..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>
          <select
            value={ratingFilter}
            onChange={(e) => setRatingFilter(e.target.value)}
            className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            <option value="">All Ratings</option>
            <option value="5">5 Stars</option>
            <option value="4">4 Stars</option>
            <option value="3">3 Stars</option>
            <option value="2">2 Stars</option>
            <option value="1">1 Star</option>
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
        {REVIEW_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? "bg-[#044b3b] text-white"
                : "bg-white text-[#64748b] border border-[#eaeaea] hover:bg-[#f8fafc]"
            }`}
          >
            {tab.label}
            <span
              className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                activeTab === tab.key ? "bg-white/20" : "bg-[#f8fafc] text-[#64748b]"
              }`}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Reviews List */}
      <div className="space-y-4">
        {filteredReviews.map((review) => (
          <ReviewCard
            key={review.id}
            review={review}
            onApprove={handleApprove}
            onReject={handleReject}
            onFlag={handleFlag}
          />
        ))}
      </div>

      {filteredReviews.length === 0 && (
        <div className="text-center py-12">
          <div className="w-16 h-16 rounded-full bg-[#f8fafc] flex items-center justify-center mx-auto mb-4">
            <MessageSquare size={24} className="text-[#9e9e9e]" />
          </div>
          <p className="text-sm text-[#64748b]">No reviews found in this category.</p>
        </div>
      )}

      {/* Pagination placeholder */}
      {filteredReviews.length > 0 && (
        <div className="flex items-center justify-center mt-6 gap-2">
          <button className="px-3 py-1.5 text-sm text-[#64748b] border border-[#eaeaea] rounded-lg hover:bg-[#f8fafc] transition-colors">
            Previous
          </button>
          <span className="px-3 py-1.5 text-sm text-[#1e293b] font-medium">Page 1 of 1</span>
          <button className="px-3 py-1.5 text-sm text-[#64748b] border border-[#eaeaea] rounded-lg hover:bg-[#f8fafc] transition-colors">
            Next
          </button>
        </div>
      )}
    </div>
  );
}
