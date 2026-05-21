import { useRef, useEffect, useState } from "react";
import { motion, useAnimation } from "framer-motion";
import { TourCard } from "./TourCard";

export function AutoScrollCarousel({ items, title }) {
  const [isPaused, setIsPaused] = useState(false);
  const controls = useAnimation();
  const containerRef = useRef(null);

  // Triple the items for seamless infinite scroll
  const infiniteItems = [...items, ...items, ...items];
  const cardWidth = 280;
  const gap = 12;
  const totalWidth = items.length * (cardWidth + gap);

  useEffect(() => {
    if (!isPaused) {
      // Continuous auto-scroll animation
      controls.start({
        x: [-totalWidth, 0],
        transition: {
          x: {
            repeat: Infinity,
            repeatType: "loop",
            duration: items.length * 3, // Adjust speed based on number of items
            ease: "linear",
          },
        },
      });
    } else {
      controls.stop();
    }
  }, [isPaused, controls, totalWidth, items.length]);

  const handleMouseEnter = () => setIsPaused(true);
  const handleMouseLeave = () => setIsPaused(false);
  const handleTouchStart = () => setIsPaused(true);
  const handleTouchEnd = () => setIsPaused(false);

  return (
    <section className="py-6 overflow-hidden">
      <div className="mx-auto max-w-[1520px] px-4 sm:px-6">
        {title && (
          <h2 className="mb-4 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
            {title}
          </h2>
        )}
      </div>

      <div
        ref={containerRef}
        className="relative overflow-hidden"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Gradient overlays for fade effect */}
        <div className="pointer-events-none absolute left-0 top-0 z-10 h-full w-20 bg-gradient-to-r from-[color:var(--page-bg)] to-transparent sm:w-32" />
        <div className="pointer-events-none absolute right-0 top-0 z-10 h-full w-20 bg-gradient-to-l from-[color:var(--page-bg)] to-transparent sm:w-32" />

        <motion.div
          animate={controls}
          className="flex gap-3 px-4 sm:px-6"
          style={{ width: "fit-content" }}
        >
          {infiniteItems.map((item, index) => (
            <motion.div
              key={`${item.title}-${index}`}
              className="w-[280px] flex-shrink-0"
              whileHover={{
                scale: 1.03,
                y: -8,
                transition: { duration: 0.2 },
              }}
              whileTap={{ scale: 0.98 }}
            >
              <TourCard {...item} />
            </motion.div>
          ))}
        </motion.div>
      </div>

      {isPaused && (
        <p className="mt-4 text-center text-xs text-slate-500 sm:text-sm">
          Hover or touch to pause • Release to continue
        </p>
      )}
    </section>
  );
}
