import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

const peopleReviews = [
  {
    title: "Accra Guided City Tour Cultural and Historical Experience",
    image: "https://images.unsplash.com/photo-1472396961693-142e6e269027?auto=format&fit=crop&w=400&q=80",
    author: "Marcia_D, Apr 2026",
    headline: "Enjoyable and Informative tour",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent varius, risus non feugiat accumsan, sem libero ultrices neque...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus porta faucibus sem, vitae convallis magna luctus et. Integer suscipit augue ut neque luctus, quis commodo justo vulputate. Suspendisse potenti. Donec posuere nisl at velit feugiat, a suscipit nisi semper. Curabitur rutrum cursus turpis, ut laoreet sem efficitur vel.",
  },
  {
    title: "Boti Waterfalls, Umbrella Rock, Aburi Gardens & Cocoa Farm",
    image: "https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?auto=format&fit=crop&w=400&q=80",
    author: "Kayley_E, Mar 2026",
    headline: "Unforgettable tour with Emmanuel",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Duis vitae velit in quam posuere pellentesque et ut neque...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Maecenas vitae justo sit amet mi condimentum faucibus. Morbi luctus bibendum erat, sed faucibus magna suscipit et. Aliquam erat volutpat. Nunc tincidunt, nisl id dictum bibendum, risus arcu fermentum sem, in facilisis sapien nibh eget lorem.",
  },
  {
    title: "African Drum and Dance Lessons",
    image: "https://images.unsplash.com/photo-1464375117522-1311d6a5b81f?auto=format&fit=crop&w=400&q=80",
    author: "Audrey_D, Mar 2026",
    headline: "Exceptional!!",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque ut mauris et risus porttitor tincidunt in sed nibh...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vestibulum blandit orci in justo convallis, eget mattis velit malesuada. Donec sit amet urna et lacus rhoncus congue. Fusce in sapien non enim posuere fermentum. Cras commodo, mauris in viverra ultricies, lectus mauris commodo nunc, in posuere est arcu eu elit.",
  },
  {
    title: "Makola Market Walking Tour",
    image: "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?auto=format&fit=crop&w=400&q=80",
    author: "ZsaZsa_S, Feb 2026",
    headline: "Sunday shopping trip to Makola ...",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed id leo eget augue tempus faucibus sed eu justo...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc molestie ultrices urna, in laoreet nulla varius nec. Nam in efficitur erat. In feugiat, tortor sed pretium bibendum, purus dui posuere sem, a feugiat sapien justo et augue. Aenean euismod vulputate ligula, eget posuere nibh varius id.",
  },
  {
    title: "Cape Coast Castle Heritage Experience",
    image: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=400&q=80",
    author: "Nora_B, Feb 2026",
    headline: "History brought to life",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Quisque varius justo non lectus fermentum, in ullamcorper risus dictum...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Cras a malesuada lorem. Vestibulum ac purus sit amet risus sagittis pellentesque. Morbi mattis libero sed sem luctus, id feugiat justo dignissim. Sed in lorem egestas, imperdiet risus et, faucibus sapien.",
  },
  {
    title: "Volta Region Nature Day Trip",
    image: "https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=400&q=80",
    author: "Pius_T, Jan 2026",
    headline: "Worth every minute",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. In placerat, sem vel fermentum tristique, tortor tortor tincidunt urna...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Curabitur luctus sed purus at aliquet. Integer gravida, est non malesuada vestibulum, lorem justo pretium augue, in egestas risus sem non purus. Etiam eget tellus et augue pretium pretium vel non orci.",
  },
  {
    title: "Kakum Canopy Walk and Forest Tour",
    image: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
    author: "Eddy_W, Jan 2026",
    headline: "Fantastic and well organized",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent ullamcorper, erat id faucibus tristique, erat nunc gravida enim...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse interdum, erat ut pulvinar luctus, mi arcu faucibus nisl, eget suscipit nibh mi at enim. Sed non massa id lorem faucibus convallis. Integer id lectus in lorem consequat fringilla.",
  },
  {
    title: "Aburi Gardens Relaxation Tour",
    image: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=400&q=80",
    author: "Clara_A, Dec 2025",
    headline: "Peaceful and refreshing",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse condimentum tincidunt dolor, id ultrices ligula lacinia non...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Aenean eu risus malesuada, pellentesque nisi at, vulputate velit. Sed eget urna in dui posuere iaculis at vitae odio. Vivamus pharetra ultrices egestas. Aliquam erat volutpat.",
  },
  {
    title: "Wli Waterfalls and Village Experience",
    image: "https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?auto=format&fit=crop&w=400&q=80",
    author: "Jared_K, Dec 2025",
    headline: "Refreshing and memorable",
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse potenti. Sed eu justo non augue tincidunt tristique...",
    fullText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer fermentum ante ut tincidunt sagittis. Mauris id diam at urna sollicitudin tristique. Sed consectetur, nunc vitae vehicula posuere, justo dolor bibendum justo, et vehicula ligula erat et arcu.",
  },
];

export function ReviewsCarousel() {
  const { t } = useTranslation();
  const scrollRef = useRef(null);
  const [activeReview, setActiveReview] = useState(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const checkScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  };

  const scroll = (direction) => {
    const el = scrollRef.current;
    if (!el) return;
    const cardWidth = el.firstElementChild?.clientWidth || 320;
    const gap = 16;
    el.scrollBy({ left: direction * (cardWidth + gap), behavior: "smooth" });
    setTimeout(checkScroll, 300);
  };

  return (
    <section className="relative bg-white py-12 sm:py-16 lg:py-20">
      <div className="mx-auto max-w-[1520px] px-4 sm:px-6 lg:px-8">
        <h5
          className="mb-8 text-center font-semibold tracking-tight text-slate-900 sm:mb-10"
          style={{ fontSize: "clamp(1.75rem, 3vw + 0.5rem, 2.5rem)" }}
        >
          {t("reviews.heading", "What are people saying about Ghana")}
        </h5>

        {/* Desktop arrows */}
        <div className="relative lg:px-12 xl:px-14">
          <button
            type="button"
            onClick={() => scroll(-1)}
            disabled={!canScrollLeft}
            className="absolute left-2 top-1/2 z-10 hidden size-9 -translate-y-1/2 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)] disabled:cursor-not-allowed disabled:opacity-30 lg:grid lg:size-10"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => scroll(1)}
            disabled={!canScrollRight}
            className="absolute right-2 top-1/2 z-10 hidden size-9 -translate-y-1/2 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-[color:var(--brand-green)] hover:text-[color:var(--brand-green)] disabled:cursor-not-allowed disabled:opacity-30 lg:grid lg:size-10"
          >
            <ChevronRight className="size-5" />
          </button>

          {/* Scroll container */}
          <div
            ref={scrollRef}
            onScroll={checkScroll}
            className="flex gap-4 overflow-x-auto px-1 pb-4 pt-2 [-ms-overflow-style:none] [scrollbar-width:none] snap-x snap-mandatory sm:px-2 lg:gap-5 lg:overflow-hidden lg:px-0 lg:pb-0 lg:pt-0 lg:snap-none [&::-webkit-scrollbar]:hidden"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {peopleReviews.map((review, idx) => (
              <article
                key={`${review.title}-${idx}`}
                className="w-[85%] shrink-0 snap-start rounded-xl border border-slate-200 bg-white p-4 sm:w-[45%] sm:p-5 lg:w-[calc(25%-15px)] lg:snap-none xl:w-[calc(25%-15px)]"
              >
                <div className="mb-3 flex items-start gap-3">
                  <img
                    src={review.image}
                    alt={review.title}
                    className="h-12 w-12 shrink-0 rounded-lg object-cover"
                    loading="lazy"
                  />
                  <h3 className="line-clamp-2 text-sm font-semibold leading-tight text-slate-900">
                    {review.title}
                  </h3>
                </div>
                <p className="mb-1 text-lg text-emerald-500">★★★★★</p>
                <p className="mb-3 text-xs text-slate-500">{review.author}</p>
                <p className="mb-1 text-sm font-semibold text-slate-800">
                  {review.headline}
                </p>
                <p className="line-clamp-3 text-sm leading-relaxed text-slate-600">
                  {review.body}
                </p>
                <button
                  type="button"
                  onClick={() => setActiveReview(review)}
                  className="mt-2 text-sm font-semibold text-slate-900 underline"
                >
                  Read more
                </button>
                <div className="mt-4">
                  <button
                    type="button"
                    className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800"
                  >
                    View Experience
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>

      {/* Review modal */}
      {activeReview && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
          onClick={() => setActiveReview(null)}
        >
          <div
            className="relative w-full max-w-lg rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setActiveReview(null)}
              className="absolute right-4 top-4 grid size-8 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              ✕
            </button>
            <h5 className="pr-8 text-md font-semibold text-slate-900">
              {activeReview.headline}
            </h5>
            <p className="mt-1 text-sm text-slate-500">{activeReview.author}</p>
            <p className="mt-4 text-sm leading-relaxed text-slate-700">
              {activeReview.fullText}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
