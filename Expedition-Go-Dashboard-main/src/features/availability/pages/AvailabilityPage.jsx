import { useState, useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Grid3X3,
  List,
  Clock,
  Users,
  Lock,
  Unlock,
  Edit3,
  Save,
  X,
} from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  getDay,
  startOfWeek,
  endOfWeek,
} from "date-fns";

const TOURS = [
  { id: "1", title: "Serengeti Safari Adventure" },
  { id: "2", title: "Zanzibar Beach Escape" },
  { id: "3", title: "Kilimanjaro Trek" },
  { id: "4", title: "Masai Mara Wildlife Tour" },
];

// Generate mock availability data
function generateMockAvailability() {
  const data = {};
  const today = new Date();
  TOURS.forEach((tour) => {
    data[tour.id] = {};
    // Generate 90 days of data
    for (let i = 0; i < 90; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dateStr = format(date, "yyyy-MM-dd");

      // Random availability status
      const rand = Math.random();
      let status, capacity, booked;
      if (rand < 0.1) {
        status = "blocked";
        capacity = 0;
        booked = 0;
      } else if (rand < 0.3) {
        status = "limited";
        capacity = 20;
        booked = 18;
      } else if (rand < 0.4) {
        status = "full";
        capacity = 20;
        booked = 20;
      } else {
        status = "available";
        capacity = 20;
        booked = Math.floor(Math.random() * 10);
      }

      data[tour.id][dateStr] = {
        status,
        capacity,
        booked,
        slots: [
          { time: "09:00", capacity: Math.ceil(capacity / 2), booked: Math.ceil(booked / 2) },
          { time: "14:00", capacity: Math.floor(capacity / 2), booked: Math.floor(booked / 2) },
        ],
      };
    }
  });
  return data;
}

const STATUS_COLORS = {
  available: { bg: "bg-[#ebfcf5]", border: "border-[#00d67f]", text: "text-[#047857]", dot: "bg-[#00d67f]", label: "Available" },
  limited: { bg: "bg-[#fffbeb]", border: "border-[#ffc400]", text: "text-[#b45309]", dot: "bg-[#ffc400]", label: "Limited" },
  full: { bg: "bg-[#ffebeb]", border: "border-[#dc3545]", text: "text-[#b91c1c]", dot: "bg-[#dc3545]", label: "Full" },
  blocked: { bg: "bg-[#f8fafc]", border: "border-[#eaeaea]", text: "text-[#64748b]", dot: "bg-[#9e9e9e]", label: "Blocked" },
};

export default function AvailabilityPage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedTour, setSelectedTour] = useState(TOURS[0].id);
  const [viewMode, setViewMode] = useState("month"); // month, week, day
  const [availability, setAvailability] = useState(generateMockAvailability);
  const [selectedDate, setSelectedDate] = useState(null);
  const [editModalOpen, setEditModalOpen] = useState(false);

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);
  const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  const tourAvailability = availability[selectedTour] || {};

  const getDayStatus = (date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    return tourAvailability[dateStr] || { status: "available", capacity: 20, booked: 0 };
  };

  const handlePrevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const handleNextMonth = () => setCurrentDate(addMonths(currentDate, 1));
  const handleToday = () => setCurrentDate(new Date());

  const handleDateClick = (date) => {
    setSelectedDate(date);
    setEditModalOpen(true);
  };

  const toggleBlockDate = (date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    const current = tourAvailability[dateStr];
    setAvailability((prev) => ({
      ...prev,
      [selectedTour]: {
        ...prev[selectedTour],
        [dateStr]: {
          ...current,
          status: current?.status === "blocked" ? "available" : "blocked",
        },
      },
    }));
  };

  // Stats for selected month
  const monthStats = useMemo(() => {
    const monthDays = days.filter((d) => isSameMonth(d, currentDate));
    let available = 0, limited = 0, full = 0, blocked = 0;
    monthDays.forEach((day) => {
      const status = getDayStatus(day).status;
      if (status === "available") available++;
      else if (status === "limited") limited++;
      else if (status === "full") full++;
      else if (status === "blocked") blocked++;
    });
    return { available, limited, full, blocked, total: monthDays.length };
  }, [currentDate, selectedTour, availability]);

  // Legend
  const LegendItem = ({ status }) => {
    const style = STATUS_COLORS[status];
    return (
      <div className="flex items-center gap-1.5">
        <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
        <span className="text-xs text-[#64748b]">{style.label}</span>
      </div>
    );
  };

  return (
    <div className="p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-[#1e293b]">Availability</h1>
          <p className="text-sm text-[#64748b] mt-1">Manage tour availability and capacity</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Tour Selector */}
          <select
            value={selectedTour}
            onChange={(e) => setSelectedTour(e.target.value)}
            className="px-3 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          >
            {TOURS.map((tour) => (
              <option key={tour.id} value={tour.id}>{tour.title}</option>
            ))}
          </select>

          {/* View Toggle */}
          <div className="flex items-center border border-[#eaeaea] rounded-lg overflow-hidden">
            {["month", "week", "day"].map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-2.5 text-sm font-medium capitalize transition-colors ${
                  viewMode === mode ? "bg-[#044b3b] text-white" : "bg-white text-[#64748b] hover:bg-[#f8fafc]"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Month Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Available Days", value: monthStats.available, color: "text-[#00d67f]" },
          { label: "Limited Days", value: monthStats.limited, color: "text-[#ffc400]" },
          { label: "Fully Booked", value: monthStats.full, color: "text-[#dc3545]" },
          { label: "Blocked Days", value: monthStats.blocked, color: "text-[#64748b]" },
        ].map((stat) => (
          <div key={stat.label} className="bg-white rounded-lg border border-[#eaeaea] p-4">
            <p className="text-xs text-[#64748b] uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Calendar Navigation */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-4">
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrevMonth}
            className="p-2 rounded-lg border border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc] transition-colors"
          >
            <ChevronLeft size={18} />
          </button>
          <h2 className="text-lg font-semibold text-[#1e293b] min-w-[200px] text-center">
            {format(currentDate, "MMMM yyyy")}
          </h2>
          <button
            onClick={handleNextMonth}
            className="p-2 rounded-lg border border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc] transition-colors"
          >
            <ChevronRight size={18} />
          </button>
          <button
            onClick={handleToday}
            className="ml-2 px-3 py-2 text-sm font-medium text-[#044b3b] bg-[#f0fdf4] rounded-lg hover:bg-[#dcfce7] transition-colors"
          >
            Today
          </button>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          {["available", "limited", "full", "blocked"].map((status) => (
            <LegendItem key={status} status={status} />
          ))}
        </div>
      </div>

      {/* Month View Calendar */}
      {viewMode === "month" && (
        <div className="bg-white rounded-lg border border-[#eaeaea] overflow-hidden">
          {/* Day Headers */}
          <div className="grid grid-cols-7 border-b border-[#eaeaea]">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div key={day} className="px-3 py-2 text-center text-xs font-semibold text-[#64748b] uppercase tracking-wider bg-[#f8fafc]">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7">
            {days.map((day, index) => {
              const dayStatus = getDayStatus(day);
              const statusStyle = STATUS_COLORS[dayStatus.status];
              const isCurrentMonth = isSameMonth(day, currentDate);
              const isToday = isSameDay(day, new Date());
              const fillPercent = dayStatus.capacity > 0 ? (dayStatus.booked / dayStatus.capacity) * 100 : 0;

              return (
                <div
                  key={index}
                  className={`min-h-[60px] sm:min-h-[100px] border-r border-b border-[#eaeaea] p-1.5 sm:p-2 relative group cursor-pointer transition-colors hover:bg-[#f8fafc] ${
                    !isCurrentMonth ? "bg-[#fafafa]" : ""
                  }`}
                  onClick={() => handleDateClick(day)}
                >
                  {/* Date Number */}
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className={`text-sm font-medium ${
                        isToday
                          ? "w-7 h-7 rounded-full bg-[#044b3b] text-white flex items-center justify-center"
                          : isCurrentMonth
                          ? "text-[#1e293b]"
                          : "text-[#9e9e9e]"
                      }`}
                    >
                      {format(day, "d")}
                    </span>
                    {/* Block/Unblock quick action */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBlockDate(day);
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-[#9e9e9e] hover:text-[#044b3b] hover:bg-[#f0fdf4]"
                      title={dayStatus.status === "blocked" ? "Unblock" : "Block"}
                    >
                      {dayStatus.status === "blocked" ? <Unlock size={12} /> : <Lock size={12} />}
                    </button>
                  </div>

                  {/* Status Indicator */}
                  {isCurrentMonth && (
                    <div className={`rounded-md p-1 sm:p-1.5 ${statusStyle.bg} border ${statusStyle.border}`}>
                      <div className="flex items-center gap-1 mb-0.5 sm:mb-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
                        <span className={`text-[9px] sm:text-[10px] font-semibold ${statusStyle.text}`}>
                          {statusStyle.label}
                        </span>
                      </div>
                      {dayStatus.status !== "blocked" && (
                        <div className="mt-0.5 sm:mt-1">
                          <div className="flex items-center justify-between text-[9px] sm:text-[10px] text-[#64748b]">
                            <span>{dayStatus.booked}/{dayStatus.capacity}</span>
                            <span>{Math.round(fillPercent)}%</span>
                          </div>
                          {/* Progress bar */}
                          <div className="w-full h-1 bg-white/50 rounded-full mt-0.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                fillPercent >= 100 ? "bg-[#dc3545]" : fillPercent >= 80 ? "bg-[#ffc400]" : "bg-[#00d67f]"
                              }`}
                              style={{ width: `${Math.min(fillPercent, 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Week View */}
      {viewMode === "week" && (
        <div className="bg-white rounded-lg border border-[#eaeaea] overflow-hidden overflow-x-auto">
          <div className="grid grid-cols-7 min-w-[600px]">
            {days.slice(0, 7).map((day, index) => {
              const dayStatus = getDayStatus(day);
              const statusStyle = STATUS_COLORS[dayStatus.status];
              const isToday = isSameDay(day, new Date());

              return (
                <div key={index} className="border-r border-[#eaeaea] p-4">
                  <div className="text-center mb-3">
                    <p className="text-xs text-[#64748b] uppercase">{format(day, "EEE")}</p>
                    <p className={`text-lg font-bold mt-1 ${isToday ? "text-[#044b3b]" : "text-[#1e293b]"}`}>
                      {format(day, "d")}
                    </p>
                  </div>
                  <div className={`rounded-lg p-3 ${statusStyle.bg} border ${statusStyle.border}`}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className={`w-2 h-2 rounded-full ${statusStyle.dot}`} />
                      <span className={`text-xs font-semibold ${statusStyle.text}`}>{statusStyle.label}</span>
                    </div>
                    {dayStatus.status !== "blocked" && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1 text-xs text-[#64748b]">
                          <Users size={12} />
                          <span>{dayStatus.booked} / {dayStatus.capacity}</span>
                        </div>
                        <div className="space-y-1">
                          {dayStatus.slots.map((slot, i) => (
                            <div key={i} className="flex items-center justify-between text-xs bg-white/50 rounded px-2 py-1">
                              <span className="flex items-center gap-1">
                                <Clock size={10} />
                                {slot.time}
                              </span>
                              <span className={slot.booked >= slot.capacity ? "text-[#dc3545]" : "text-[#64748b]"}>
                                {slot.booked}/{slot.capacity}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Day View */}
      {viewMode === "day" && (
        <div className="bg-white rounded-lg border border-[#eaeaea] p-6">
          <div className="text-center mb-6">
            <h3 className="text-xl font-bold text-[#1e293b]">{format(currentDate, "EEEE, MMMM d, yyyy")}</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {TOURS.map((tour) => {
              const dateStr = format(currentDate, "yyyy-MM-dd");
              const tourData = availability[tour.id]?.[dateStr] || { status: "available", capacity: 20, booked: 0 };
              const style = STATUS_COLORS[tourData.status];

              return (
                <div key={tour.id} className={`rounded-lg p-4 border ${style.border} ${style.bg}`}>
                  <h4 className="text-sm font-semibold text-[#1e293b] mb-3">{tour.title}</h4>
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                    <span className={`text-sm font-medium ${style.text}`}>{style.label}</span>
                  </div>
                  {tourData.status !== "blocked" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-[#64748b]">Capacity</span>
                        <span className="font-medium text-[#1e293b]">{tourData.booked} / {tourData.capacity}</span>
                      </div>
                      <div className="w-full h-2 bg-white/50 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            tourData.booked >= tourData.capacity ? "bg-[#dc3545]" : "bg-[#00d67f]"
                          }`}
                          style={{ width: `${(tourData.booked / tourData.capacity) * 100}%` }}
                        />
                      </div>
                      <div className="pt-2 border-t border-[#eaeaea]/50 space-y-1">
                        {tourData.slots?.map((slot, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1 text-[#64748b]">
                              <Clock size={10} /> {slot.time}
                            </span>
                            <span className="font-medium text-[#1e293b]">{slot.booked}/{slot.capacity}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editModalOpen && selectedDate && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-full sm:max-w-md w-full mx-4 p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1e293b]">
                {format(selectedDate, "MMMM d, yyyy")}
              </h3>
              <button
                onClick={() => setEditModalOpen(false)}
                className="p-1.5 text-[#9e9e9e] hover:text-[#1e293b] hover:bg-[#f8fafc] rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {(() => {
              const dateStr = format(selectedDate, "yyyy-MM-dd");
              const dayData = tourAvailability[dateStr] || { status: "available", capacity: 20, booked: 0 };

              return (
                <div className="space-y-4">
                  {/* Status */}
                  <div>
                    <label className="block text-sm font-medium text-[#1e293b] mb-2">Status</label>
                    <div className="grid grid-cols-2 gap-2">
                      {["available", "limited", "full", "blocked"].map((status) => {
                        const style = STATUS_COLORS[status];
                        return (
                          <button
                            key={status}
                            onClick={() => {
                              setAvailability((prev) => ({
                                ...prev,
                                [selectedTour]: {
                                  ...prev[selectedTour],
                                  [dateStr]: { ...dayData, status },
                                },
                              }));
                            }}
                            className={`p-2.5 rounded-lg border text-sm font-medium transition-colors ${
                              dayData.status === status
                                ? `${style.bg} ${style.border} ${style.text}`
                                : "border-[#eaeaea] text-[#64748b] hover:bg-[#f8fafc]"
                            }`}
                          >
                            {style.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Capacity */}
                  {dayData.status !== "blocked" && (
                    <div>
                      <label className="block text-sm font-medium text-[#1e293b] mb-2">
                        Capacity per Slot
                      </label>
                      <input
                        type="number"
                        value={dayData.capacity}
                        onChange={(e) => {
                          setAvailability((prev) => ({
                            ...prev,
                            [selectedTour]: {
                              ...prev[selectedTour],
                              [dateStr]: { ...dayData, capacity: Number(e.target.value) },
                            },
                          }));
                        }}
                        min="1"
                        className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                      />
                    </div>
                  )}

                  {/* Time Slots */}
                  {dayData.status !== "blocked" && dayData.slots && (
                    <div>
                      <label className="block text-sm font-medium text-[#1e293b] mb-2">Time Slots</label>
                      <div className="space-y-2">
                        {dayData.slots.map((slot, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <input
                              type="time"
                              value={slot.time}
                              onChange={(e) => {
                                const newSlots = [...dayData.slots];
                                newSlots[index] = { ...slot, time: e.target.value };
                                setAvailability((prev) => ({
                                  ...prev,
                                  [selectedTour]: {
                                    ...prev[selectedTour],
                                    [dateStr]: { ...dayData, slots: newSlots },
                                  },
                                }));
                              }}
                              className="flex-1 px-3 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                            />
                            <input
                              type="number"
                              value={slot.capacity}
                              onChange={(e) => {
                                const newSlots = [...dayData.slots];
                                newSlots[index] = { ...slot, capacity: Number(e.target.value) };
                                setAvailability((prev) => ({
                                  ...prev,
                                  [selectedTour]: {
                                    ...prev[selectedTour],
                                    [dateStr]: { ...dayData, slots: newSlots },
                                  },
                                }));
                              }}
                              min="1"
                              className="w-20 px-3 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                              placeholder="Cap"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-3 pt-4 border-t border-[#eaeaea]">
                    <button
                      onClick={() => setEditModalOpen(false)}
                      className="flex-1 px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
                    >
                      Save Changes
                    </button>
                    <button
                      onClick={() => {
                        toggleBlockDate(selectedDate);
                        setEditModalOpen(false);
                      }}
                      className="px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm font-medium text-[#64748b] hover:bg-[#f8fafc] transition-colors"
                    >
                      {dayData.status === "blocked" ? "Unblock" : "Block"} Date
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
