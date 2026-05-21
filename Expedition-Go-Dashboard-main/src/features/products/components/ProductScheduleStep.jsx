import { Plus, Trash2, Clock, Calendar } from "lucide-react";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

const DAYS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
  { value: "saturday", label: "Sat" },
  { value: "sunday", label: "Sun" },
];

const SEASONS = [
  { value: "all_year", label: "All Year" },
  { value: "peak", label: "Peak Season Only" },
  { value: "off_peak", label: "Off-Peak Only" },
  { value: "custom", label: "Custom Dates" },
];

export default function ProductScheduleStep() {
  const { product, errors, updateNested } = useProductBuilderStore();
  const { schedule } = product;

  const toggleDay = (day) => {
    const newDays = schedule.operatingDays.includes(day)
      ? schedule.operatingDays.filter((d) => d !== day)
      : [...schedule.operatingDays, day];
    updateNested("schedule.operatingDays", newDays);
  };

  const addTimeSlot = () => {
    const newSlots = [...schedule.timeSlots, { startTime: "09:00", endTime: "12:00" }];
    updateNested("schedule.timeSlots", newSlots);
  };

  const updateTimeSlot = (index, field, value) => {
    const newSlots = schedule.timeSlots.map((slot, i) =>
      i === index ? { ...slot, [field]: value } : slot
    );
    updateNested("schedule.timeSlots", newSlots);
  };

  const removeTimeSlot = (index) => {
    const newSlots = schedule.timeSlots.filter((_, i) => i !== index);
    updateNested("schedule.timeSlots", newSlots);
  };

  const addBlackoutDate = () => {
    const newDates = [...schedule.blackoutDates, ""];
    updateNested("schedule.blackoutDates", newDates);
  };

  const updateBlackoutDate = (index, value) => {
    const newDates = schedule.blackoutDates.map((date, i) => (i === index ? value : date));
    updateNested("schedule.blackoutDates", newDates);
  };

  const removeBlackoutDate = (index) => {
    const newDates = schedule.blackoutDates.filter((_, i) => i !== index);
    updateNested("schedule.blackoutDates", newDates);
  };

  return (
    <div className="space-y-6">
      {/* Operating Days */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-3">
          Operating Days <span className="text-[#dc3545]">*</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((day) => (
            <button
              key={day.value}
              onClick={() => toggleDay(day.value)}
              className={`flex-1 min-w-[3rem] py-2.5 px-2 sm:px-3 rounded-lg text-xs sm:text-sm font-medium transition-colors ${
                schedule.operatingDays.includes(day.value)
                  ? "bg-[#044b3b] text-white"
                  : "bg-[#f8fafc] text-[#64748b] border border-[#eaeaea] hover:bg-[#f0fdf4] hover:text-[#044b3b]"
              }`}
            >
              {day.label}
            </button>
          ))}
        </div>
        {errors.operatingDays && <p className="mt-1 text-xs text-[#dc3545]">{errors.operatingDays}</p>}
      </div>

      {/* Time Slots */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[#1e293b]">
            <span className="flex items-center gap-2">
              <Clock size={16} className="text-[#64748b]" />
              Time Slots
            </span>
          </h3>
          <button
            onClick={addTimeSlot}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#044b3b] bg-[#f0fdf4] rounded-md hover:bg-[#dcfce7] transition-colors"
          >
            <Plus size={12} />
            Add Slot
          </button>
        </div>

        <div className="space-y-3">
          {schedule.timeSlots.map((slot, index) => (
            <div key={index} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 bg-[#f8fafc] rounded-lg border border-[#eaeaea]">
              <span className="text-sm text-[#64748b] w-8">{index + 1}.</span>
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#64748b] mb-1">Start Time</label>
                  <input
                    type="time"
                    value={slot.startTime}
                    onChange={(e) => updateTimeSlot(index, "startTime", e.target.value)}
                    className="w-full px-3 py-2 border border-[#eaeaea] rounded-md text-sm text-[#1e293b] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#64748b] mb-1">End Time</label>
                  <input
                    type="time"
                    value={slot.endTime}
                    onChange={(e) => updateTimeSlot(index, "endTime", e.target.value)}
                    className="w-full px-3 py-2 border border-[#eaeaea] rounded-md text-sm text-[#1e293b] focus:outline-none focus:ring-1 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
                  />
                </div>
              </div>
              {schedule.timeSlots.length > 1 && (
                <button
                  onClick={() => removeTimeSlot(index)}
                  className="p-2 text-[#9e9e9e] hover:text-[#dc3545] transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Seasonal Availability */}
      <div>
        <label className="block text-sm font-medium text-[#1e293b] mb-2">
          <span className="flex items-center gap-2">
            <Calendar size={16} className="text-[#64748b]" />
            Seasonal Availability
          </span>
        </label>
        <select
          value={schedule.seasonalAvailability}
          onChange={(e) => updateNested("schedule.seasonalAvailability", e.target.value)}
          className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] bg-white focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
        >
          {SEASONS.map((season) => (
            <option key={season.value} value={season.value}>{season.label}</option>
          ))}
        </select>
      </div>

      {/* Capacity & Cutoff */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Capacity Per Slot</label>
          <input
            type="number"
            value={schedule.capacityPerSlot}
            onChange={(e) => updateNested("schedule.capacityPerSlot", Number(e.target.value))}
            min="1"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-[#1e293b] mb-2">Booking Cutoff (Hours Before)</label>
          <input
            type="number"
            value={schedule.bookingCutoffHours}
            onChange={(e) => updateNested("schedule.bookingCutoffHours", Number(e.target.value))}
            min="0"
            className="w-full px-4 py-2.5 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
          />
        </div>
      </div>

      {/* Blackout Dates */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[#1e293b]">Blackout Dates</h3>
          <button
            onClick={addBlackoutDate}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#044b3b] bg-[#f0fdf4] rounded-md hover:bg-[#dcfce7] transition-colors"
          >
            <Plus size={12} />
            Add Date
          </button>
        </div>

        <div className="space-y-2">
          {schedule.blackoutDates.map((date, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={(e) => updateBlackoutDate(index, e.target.value)}
                className="flex-1 px-4 py-2 border border-[#eaeaea] rounded-lg text-sm text-[#1e293b] focus:outline-none focus:ring-2 focus:ring-[#044b3b]/20 focus:border-[#044b3b]"
              />
              <button
                onClick={() => removeBlackoutDate(index)}
                className="p-2 text-[#9e9e9e] hover:text-[#dc3545] transition-colors"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {schedule.blackoutDates.length === 0 && (
            <p className="text-sm text-[#64748b] italic">No blackout dates set</p>
          )}
        </div>
      </div>
    </div>
  );
}
