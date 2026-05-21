import { Upload, X, Image as ImageIcon, GripVertical, Star, Video } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

export default function ProductPhotosStep() {
  const { product, updateProduct } = useProductBuilderStore();

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    const newPhotos = files.map((file) => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      url: URL.createObjectURL(file),
      alt: "",
    }));
    updateProduct({ photos: [...product.photos, ...newPhotos] });
  };

  const removePhoto = (id) => {
    const newPhotos = product.photos.filter((p) => p.id !== id);
    updateProduct({ photos: newPhotos });
    if (product.heroImage === id) {
      updateProduct({ heroImage: null });
    }
  };

  const setHero = (id) => {
    updateProduct({ heroImage: id });
  };

  const updateAlt = (id, alt) => {
    const newPhotos = product.photos.map((p) =>
      p.id === id ? { ...p, alt } : p
    );
    updateProduct({ photos: newPhotos });
  };

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      <div className="border-2 border-dashed border-[#eaeaea] rounded-lg p-8 text-center bg-[#f8fafc]">
        <Upload size={40} className="mx-auto text-[#9e9e9e] mb-3" />
        <p className="text-sm font-medium text-[#1e293b] mb-1">
          Drag and drop photos here, or{" "}
          <label className="text-[#044b3b] cursor-pointer hover:underline">
            browse
            <input type="file" multiple accept="image/*" className="hidden" onChange={handleFileSelect} />
          </label>
        </p>
        <p className="text-xs text-[#64748b]">Supports JPG, PNG, WebP. Max 5MB per image.</p>
      </div>

      {/* Photo Gallery */}
      {product.photos.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#1e293b]">Photos ({product.photos.length})</h3>
            <p className="text-xs text-[#64748b]">
              {product.heroImage ? "Hero image selected" : "Click star to set hero image"}
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {product.photos.map((photo) => (
              <div
                key={photo.id}
                className={`group relative rounded-lg border overflow-hidden ${
                  product.heroImage === photo.id ? "border-[#044b3b] ring-2 ring-[#044b3b]/20" : "border-[#eaeaea]"
                }`}
              >
                <div className="aspect-[4/3] bg-[#f8fafc] relative">
                  <img src={photo.url} alt={photo.alt} className="w-full h-full object-cover" />
                </div>

                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setHero(photo.id)}
                    className={`p-1.5 rounded-md ${
                      product.heroImage === photo.id ? "bg-[#044b3b] text-white" : "bg-white/90 text-[#9e9e9e] hover:text-[#044b3b]"
                    }`}
                  >
                    <Star size={14} />
                  </button>
                  <button onClick={() => removePhoto(photo.id)} className="p-1.5 rounded-md bg-white/90 text-[#9e9e9e] hover:text-[#dc3545]">
                    <X size={14} />
                  </button>
                </div>

                {product.heroImage === photo.id && (
                  <div className="absolute bottom-2 left-2 px-2 py-1 bg-[#044b3b] text-white text-[10px] font-bold rounded-md">
                    HERO
                  </div>
                )}

                <div className="p-2">
                  <input
                    type="text"
                    value={photo.alt}
                    onChange={(e) => updateAlt(photo.id, e.target.value)}
                    placeholder="Alt text"
                    className="w-full px-2 py-1 text-xs border border-[#eaeaea] rounded text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Video URL */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">
          <span className="flex items-center gap-2"><Video size={16} className="text-[#64748b]" /> Promotional Video URL</span>
        </label>
        <input
          type="url"
          value={product.videoUrl}
          onChange={(e) => updateProduct({ videoUrl: e.target.value })}
          placeholder="https://youtube.com/watch?v=..."
          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        />
        <p className="text-xs text-[#64748b] mt-1">Add a YouTube or Vimeo URL to showcase your tour experience.</p>
      </div>
    </div>
  );
}
