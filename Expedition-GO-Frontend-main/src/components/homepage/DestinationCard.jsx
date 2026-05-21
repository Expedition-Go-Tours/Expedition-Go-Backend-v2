import { Heart } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useWishlist } from "@/contexts/WishlistContext";

export function DestinationCard({ title, tours, image, variant = "default" }) {
  const { toggleWishlist, isInWishlist } = useWishlist();
  const isFavorited = isInWishlist(title);

  const handleHeartClick = (e) => {
    e.stopPropagation();
    toggleWishlist({ 
      title, 
      image,
      duration: "Full Day",
      price: "$50",
      rating: "4.7",
      reviews: "150"
    });
  };
  const imageHeightClass = variant === "allTours" ? "h-[10rem] xl:h-[11rem]" : "h-32 xl:h-36";

  return (
    <Card className="group cursor-pointer overflow-hidden rounded-[12px] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition duration-300 xl:hover:-translate-y-1 xl:hover:shadow-none xl:active:scale-95 xl:active:shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <div className={`relative ${imageHeightClass} overflow-hidden`}>
        <img src={image} alt={title} className="h-full w-full object-cover transition duration-500 xl:group-hover:scale-110" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent pointer-events-none" />
        <button 
          onClick={handleHeartClick}
          className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-white/88 text-slate-700 shadow-sm backdrop-blur transition xl:hover:bg-white xl:hover:scale-110 z-10"
        >
          <Heart 
            className={`size-3.5 transition-colors ${
              isFavorited ? 'fill-[color:var(--brand-green)] text-[color:var(--brand-green)]' : ''
            }`} 
          />
        </button>
        <div className="absolute inset-x-0 bottom-0 p-3 text-white pointer-events-none">
          <p className="text-[20px] font-bold tracking-tight xl:text-[18px]">{title}</p>
          <p className="mt-0.5 text-[13px] text-white/78 xl:text-[12px]">{tours}</p>
        </div>
      </div>
    </Card>
  );
}
