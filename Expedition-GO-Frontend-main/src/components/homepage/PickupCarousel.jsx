import { useRef, useState, useEffect } from "react";
import { motion, useMotionValue, useAnimation } from "framer-motion";
import { TourCard } from "./TourCard";

export function PickupCarousel({ items }) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const controls = useAnimation();
  const x = useMotionValue(0);

  useEffect(() => {
    if (containerRef.current) {
      setContainerWidth(containerRef.current.offsetWidth);
    }

    const handleResize = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const cardWidth = 280;
  const gap = 12;
  const totalWidth = (cardWidth + gap) * items.length;
  const maxDrag = containerWidth - totalWidth;

  const handleDragStart = () => {
    setIsDragging(true);
  };

  const handleDragEnd = (event, info) => {
    setIsDragging(false);
    
    const offset = info.offset.x;
    const velocity = info.velocity.x;
    const currentX = x.get();

    let targetX = currentX;

    // Calculate target based on velocity or offset
    if (Math.abs(velocity) > 500) {
      targetX = currentX + velocity * 0.1;
    } else if (Math.abs(offset) > 50) {
      const cardMove = cardWidth + gap;
      targetX = currentX + (offset > 0 ? cardMove : -cardMove);
    }

    // Constrain to bounds
    targetX = Math.max(maxDrag, Math.min(0, targetX));

    // Animate to position
    controls.start({
      x: targetX,
      transition: {
        type: "spring",
        stiffness: 300,
        damping: 30,
      }
    });
  };

  return (
    <div ref={containerRef} className="overflow-hidden touch-pan-y">
      <motion.div
        drag="x"
        dragConstraints={{ left: maxDrag, right: 0 }}
        dragElastic={0.2}
        dragMomentum={true}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        animate={controls}
        style={{ x }}
        className={`flex gap-3 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        {items.map((item) => (
          <motion.div
            key={item.title}
            className="min-w-[280px] flex-shrink-0"
            whileHover={{ scale: 1.02, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <div className={isDragging ? 'pointer-events-none select-none' : ''}>
              <TourCard {...item} />
            </div>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
