import { Search, Bell, ChevronDown } from "lucide-react";
import { useSidebarStore } from "@/stores/sidebarStore";

export default function Header() {
  const { isCollapsed } = useSidebarStore();

  return (
    <header
      className={`fixed top-0 right-0 h-16 bg-white border-b border-[#eaeaea] flex items-center justify-between px-4 lg:px-6 z-40 transition-all duration-300 ${
        isCollapsed ? "lg:left-[70px]" : "lg:left-[260px]"
      } left-0`}
    >
      {/* Left: Search */}
      <div className="flex items-center gap-4 flex-1 min-w-0 ml-10 lg:ml-0">
        <div className="relative w-full max-w-xs sm:max-w-sm md:max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9e9e9e]" />
          <input
            type="text"
            placeholder="Search..."
            className="w-full pl-9 pr-4 py-2 bg-[#f8fafc] border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] placeholder:text-[#9e9e9e] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2 sm:gap-4">
        {/* Notifications */}
        <button className="relative p-2 text-[#6f6f6f] hover:text-[#1e293b] hover:bg-[#f8fafc] rounded-lg transition-colors">
          <Bell size={20} />
          <span className="absolute top-1 right-1 w-4 h-4 bg-[#dc3545] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            3
          </span>
        </button>

        {/* User Profile */}
        <div className="flex items-center gap-2 sm:gap-3 pl-2 sm:pl-4 border-l border-[#eaeaea]">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium text-[#1e293b]">Admin User</p>
            <p className="text-xs text-[#64748b]">Administrator</p>
          </div>
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#044b3b] flex items-center justify-center text-white font-medium text-sm cursor-pointer">
            A
          </div>
          <ChevronDown size={14} className="text-[#9e9e9e] hidden sm:block" />
        </div>
      </div>
    </header>
  );
}
