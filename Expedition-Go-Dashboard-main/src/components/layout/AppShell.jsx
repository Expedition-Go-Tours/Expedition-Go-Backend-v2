import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Header from "./Header";
import { useSidebarStore } from "@/stores/sidebarStore";

export default function AppShell() {
  const { isCollapsed, isMobileOpen } = useSidebarStore();

  return (
    <div className="min-h-screen bg-white">
      <Sidebar />
      <Header />
      {/* Mobile overlay */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => useSidebarStore.getState().closeMobile()}
        />
      )}
      <main
        className={`pt-16 min-h-screen transition-all duration-300 ${
          isCollapsed ? "lg:ml-[70px]" : "lg:ml-[260px]"
        }`}
      >
        <div className="bg-white min-h-[calc(100vh-64px)]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
