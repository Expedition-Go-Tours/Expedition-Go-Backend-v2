import { motion } from "framer-motion";
import { TourCard } from "./TourCard";
import { SectionHeading } from "./SectionHeading";

export function NewExperiencesSection({ items }) {
  const containerVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: {
        duration: 0.5,
        staggerChildren: 0.1
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: { duration: 0.4 }
    }
  };

  return (
    <motion.section 
      className="py-1.5 xl:py-2"
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.2 }}
      variants={containerVariants}
    >
      <SectionHeading title="New Experiences" />

      {/* Grid layout: 3 columns on desktop, 2 on tablet, 1 on mobile */}
      <div className="grid gap-2 sm:gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:gap-3">
        {items.map((item, index) => (
          <motion.div
            key={`${item.title}-${index}`}
            variants={itemVariants}
          >
            <TourCard {...item} />
          </motion.div>
        ))}
      </div>
    </motion.section>
  );
}
