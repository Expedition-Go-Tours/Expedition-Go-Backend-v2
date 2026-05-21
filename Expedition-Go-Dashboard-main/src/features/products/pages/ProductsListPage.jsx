import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Filter, Grid3X3, List, Plus, Eye, Edit, Trash2 } from "lucide-react";
import StatusBadge from "@/components/shared/StatusBadge";
import { PRODUCT_STATUSES } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

// Mock products data
const MOCK_PRODUCTS = [
  { id: "1", title: "Serengeti Safari Adventure", category: "safari", status: "ACTIVE", supplier: "Serengeti Tours Ltd.", basePrice: 600, currency: "USD", totalBookings: 142, rating: 4.8, lastUpdated: "2026-05-15", image: null },
  { id: "2", title: "Zanzibar Beach Escape", category: "beach", status: "ACTIVE", supplier: "Zanzibar Adventures", basePrice: 450, currency: "USD", totalBookings: 89, rating: 4.6, lastUpdated: "2026-05-12", image: null },
  { id: "3", title: "Kilimanjaro Trek - 7 Days", category: "trekking", status: "ACTIVE", supplier: "Kili Expeditions", basePrice: 3200, currency: "USD", totalBookings: 56, rating: 4.9, lastUpdated: "2026-05-10", image: null },
  { id: "4", title: "Masai Mara Wildlife Tour", category: "wildlife", status: "PENDING_APPROVAL", supplier: "Mara Safaris", basePrice: 650, currency: "USD", totalBookings: 0, rating: 0, lastUpdated: "2026-05-18", image: null },
  { id: "5", title: "Victoria Falls Expedition", category: "adventure", status: "ACTIVE", supplier: "Victoria Tours", basePrice: 700, currency: "USD", totalBookings: 203, rating: 4.7, lastUpdated: "2026-05-08", image: null },
  { id: "6", title: "Ngorongoro Crater Day Trip", category: "safari", status: "DRAFT", supplier: "Crater Views", basePrice: 400, currency: "USD", totalBookings: 0, rating: 0, lastUpdated: "2026-05-17", image: null },
  { id: "7", title: "Okavango Delta Safari", category: "safari", status: "ACTIVE", supplier: "Delta Expeditions", basePrice: 2100, currency: "USD", totalBookings: 67, rating: 4.8, lastUpdated: "2026-05-05", image: null },
  { id: "8", title: "Cape Town City & Winelands", category: "city", status: "INACTIVE", supplier: "Cape Experiences", basePrice: 350, currency: "USD", totalBookings: 45, rating: 4.5, lastUpdated: "2026-04-28", image: null },
];

const CATEGORIES = [
  { value: "", label: "All Categories" },
  { value: "safari", label: "Safari" },
  { value: "beach", label: "Beach & Island" },
  { value: "adventure", label: "Adventure" },
  { value: "cultural", label: "Cultural" },
  { value: "city", label: "City Tour" },
  { value: "wildlife", label: "Wildlife" },
  { value: "trekking", label: "Trekking & Hiking" },
];

export default function ProductsListPage() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState("grid"); // "grid" or "table"
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const filteredProducts = MOCK_PRODUCTS.filter((product) => {
    const matchesSearch = !search ||
      product.title.toLowerCase().includes(search.toLowerCase()) ||
      product.supplier.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !categoryFilter || product.category === categoryFilter;
    const matchesStatus = !statusFilter || product.status === statusFilter;
    return matchesSearch && matchesCategory && matchesStatus;
  });

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Products</h1>
          <p className="text-sm text-[#64748b] mt-1">Manage your tour products and experiences</p>
        </div>
        <button
          onClick={() => navigate("/products/build/new/type")}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
        >
          <Plus size={16} />
          Create Product
        </button>
      </div>

      {/* Filters & View Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-1">
          {/* Search */}
          <div className="relative flex-1 w-full sm:max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
            <input
              type="text"
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
            />
          </div>

          {/* Category Filter */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value}>{cat.label}</option>
            ))}
          </select>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            <option value="">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="DRAFT">Draft</option>
            <option value="PENDING_APPROVAL">Pending Approval</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>

        {/* View Toggle */}
        <div className="flex items-center border border-[#eaeaea] rounded-lg overflow-hidden">
          <button
            onClick={() => setViewMode("grid")}
            className={`p-2.5 transition-colors ${viewMode === "grid" ? "bg-[#044b3b] text-white" : "bg-white text-[#64748b] hover:bg-[#f8fafc]"}`}
          >
            <Grid3X3 size={18} />
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`p-2.5 transition-colors ${viewMode === "table" ? "bg-[#044b3b] text-white" : "bg-white text-[#64748b] hover:bg-[#f8fafc]"}`}
          >
            <List size={18} />
          </button>
        </div>
      </div>

      {/* Results Count */}
      <p className="text-sm text-[#64748b] mb-4">
        Showing {filteredProducts.length} of {MOCK_PRODUCTS.length} products
      </p>

      {/* Grid View */}
      {viewMode === "grid" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredProducts.map((product) => (
            <div
              key={product.id}
              className="bg-white rounded-lg border border-[#eaeaea] overflow-hidden hover:shadow-md transition-shadow"
            >
              {/* Image Placeholder */}
              <div className="aspect-[16/9] bg-[#f8fafc] flex items-center justify-center relative">
                <div className="w-12 h-12 rounded-full bg-[#eaeaea] flex items-center justify-center">
                  <span className="text-2xl text-[#9e9e9e]">🏞️</span>
                </div>
                <div className="absolute top-3 left-3">
                  <StatusBadge status={product.status} label={PRODUCT_STATUSES[product.status]?.label} size="sm" />
                </div>
              </div>

              {/* Content */}
              <div className="p-4">
                <h3 className="text-sm font-semibold text-[#1e293b] line-clamp-1" title={product.title}>
                  {product.title}
                </h3>
                <p className="text-xs text-[#64748b] mt-1">{product.supplier}</p>

                <div className="flex items-center gap-2 mt-3">
                  <span className="text-lg font-bold text-[#044b3b]">
                    {formatCurrency(product.basePrice, product.currency)}
                  </span>
                  <span className="text-xs text-[#64748b]">/ person</span>
                </div>

                <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#eaeaea]">
                  <div className="flex items-center gap-3 text-xs text-[#64748b]">
                    <span>{product.totalBookings} bookings</span>
                    {product.rating > 0 && (
                      <span className="flex items-center gap-0.5">
                        ⭐ {product.rating}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => navigate(`/products/build/${product.id}/type`)}
                      className="p-1.5 text-[#64748b] hover:text-[#044b3b] hover:bg-[#f0fdf4] rounded-md transition-colors"
                      title="Edit"
                    >
                      <Edit size={14} />
                    </button>
                    <button className="p-1.5 text-[#64748b] hover:text-[#dc3545] hover:bg-[#ffebeb] rounded-md transition-colors" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === "table" && (
        <div className="bg-white rounded-lg border border-[#eaeaea] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#eaeaea] bg-[#f8fafc]">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Product</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Category</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Price</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Bookings</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Rating</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Last Updated</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[#64748b] uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product) => (
                  <tr key={product.id} className="border-b border-[#eaeaea] hover:bg-[#f8fafc] transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-[#1e293b]">{product.title}</p>
                        <p className="text-xs text-[#64748b]">{product.supplier}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="capitalize text-[#64748b]">{product.category}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={product.status} label={PRODUCT_STATUSES[product.status]?.label} size="sm" />
                    </td>
                    <td className="px-4 py-3 font-medium text-[#1e293b]">
                      {formatCurrency(product.basePrice, product.currency)}
                    </td>
                    <td className="px-4 py-3 text-[#1e293b]">{product.totalBookings}</td>
                    <td className="px-4 py-3">
                      {product.rating > 0 ? (
                        <span className="flex items-center gap-1 text-[#1e293b]">
                          ⭐ {product.rating}
                        </span>
                      ) : (
                        <span className="text-[#9e9e9e]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[#64748b]">{formatDate(product.lastUpdated)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => navigate(`/products/build/${product.id}/type`)}
                          className="p-1.5 text-[#64748b] hover:text-[#044b3b] hover:bg-[#f0fdf4] rounded-md transition-colors"
                        >
                          <Edit size={14} />
                        </button>
                        <button className="p-1.5 text-[#64748b] hover:text-[#dc3545] hover:bg-[#ffebeb] rounded-md transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filteredProducts.length === 0 && (
        <div className="text-center py-12">
          <div className="w-16 h-16 rounded-full bg-[#f8fafc] flex items-center justify-center mx-auto mb-4">
            <Search size={24} className="text-[#9e9e9e]" />
          </div>
          <p className="text-sm text-[#64748b]">No products match your filters.</p>
          <button
            onClick={() => { setSearch(""); setCategoryFilter(""); setStatusFilter(""); }}
            className="mt-2 text-sm text-[#044b3b] hover:underline"
          >
            Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}
