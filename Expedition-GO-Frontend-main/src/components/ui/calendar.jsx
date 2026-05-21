import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function Calendar({ selected, onSelect, onClose, mode = "single" }) {
  const today = new Date();
  const isTouchDevice = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
    []
  );
  
  // Initialize currentMonth based on mode
  const getInitialMonth = () => {
    if (mode === "range" && selected?.from) {
      return new Date(selected.from);
    } else if (mode === "single" && selected) {
      return new Date(selected);
    }
    return today;
  };
  
  const [currentMonth, setCurrentMonth] = useState(getInitialMonth());
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [hoverDate, setHoverDate] = useState(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const handleDateClick = (day) => {
    const clickedDate = new Date(year, month, day);
    
    if (mode === "range") {
      // Tap/click range selection uses the controlled selected value.
      // This keeps touch devices from prematurely finalizing a same-day range.
      if (!selected?.from || selected?.to) {
        setDragStart(clickedDate);
        setDragEnd(null);
        onSelect({ from: clickedDate, to: null });
      } else {
        const fromDate = selected.from;
        const from = fromDate < clickedDate ? fromDate : clickedDate;
        const to = fromDate < clickedDate ? clickedDate : fromDate;
        setDragEnd(to);
        onSelect({ from, to });
      }
    } else {
      onSelect(clickedDate);
      if (onClose) onClose();
    }
  };

  const handleMouseDown = (day) => {
    if (mode !== "range") return;
    const selectedDate = new Date(year, month, day);
    setIsDragging(true);
    setDragStart(selectedDate);
    setDragEnd(null);
  };

  const handleMouseEnter = (day) => {
    const selectedDate = new Date(year, month, day);
    setHoverDate(selectedDate);
    
    if (mode === "range" && isDragging && dragStart) {
      setDragEnd(selectedDate);
    }
  };

  const handleMouseUp = (day) => {
    if (mode !== "range" || !isDragging) return;
    const selectedDate = new Date(year, month, day);
    setIsDragging(false);
    
    if (dragStart) {
      const from = dragStart < selectedDate ? dragStart : selectedDate;
      const to = dragStart < selectedDate ? selectedDate : dragStart;
      setDragEnd(to);
      onSelect({ from, to });
    }
  };

  const isToday = (day) => {
    return (
      day === today.getDate() &&
      month === today.getMonth() &&
      year === today.getFullYear()
    );
  };

  const isSelected = (day) => {
    if (!selected) return false;
    
    if (mode === "range") {
      const date = new Date(year, month, day);
      const from = selected.from;
      const to = selected.to;
      
      if (from && to) {
        return date >= from && date <= to;
      } else if (from) {
        return (
          day === from.getDate() &&
          month === from.getMonth() &&
          year === from.getFullYear()
        );
      }
      return false;
    } else {
      const selectedDate = new Date(selected);
      return (
        day === selectedDate.getDate() &&
        month === selectedDate.getMonth() &&
        year === selectedDate.getFullYear()
      );
    }
  };

  const isInDragRange = (day) => {
    if (mode !== "range" || !dragStart) return false;
    
    const date = new Date(year, month, day);
    
    // Show hover preview when selecting range
    if (!dragEnd && hoverDate && !isDragging) {
      const from = dragStart < hoverDate ? dragStart : hoverDate;
      const to = dragStart < hoverDate ? hoverDate : dragStart;
      return date > from && date < to;
    }
    
    // Show range during drag
    const end = isDragging ? (hoverDate || dragEnd) : dragEnd;
    
    if (!end) return false;
    
    const from = dragStart < end ? dragStart : end;
    const to = dragStart < end ? end : dragStart;
    
    return date > from && date < to;
  };

  const isRangeStart = (day) => {
    if (mode !== "range" || !dragStart) return false;
    
    // Show hover preview when selecting range
    if (!dragEnd && hoverDate && !isDragging) {
      const from = dragStart < hoverDate ? dragStart : hoverDate;
      return (
        day === from.getDate() &&
        month === from.getMonth() &&
        year === from.getFullYear()
      );
    }
    
    const end = dragEnd || (isDragging ? hoverDate : null);
    
    if (!end) {
      return (
        day === dragStart.getDate() &&
        month === dragStart.getMonth() &&
        year === dragStart.getFullYear()
      );
    }
    
    const from = dragStart < end ? dragStart : end;
    return (
      day === from.getDate() &&
      month === from.getMonth() &&
      year === from.getFullYear()
    );
  };

  const isRangeEnd = (day) => {
    if (mode !== "range" || !dragStart) return false;
    
    // Show hover preview when selecting range
    if (!dragEnd && hoverDate && !isDragging) {
      const to = dragStart < hoverDate ? hoverDate : dragStart;
      return (
        day === to.getDate() &&
        month === to.getMonth() &&
        year === to.getFullYear()
      );
    }
    
    const end = dragEnd || (isDragging ? hoverDate : null);
    
    if (!end) return false;
    
    const to = dragStart < end ? end : dragStart;
    return (
      day === to.getDate() &&
      month === to.getMonth() &&
      year === to.getFullYear()
    );
  };

  const isPastDate = (day) => {
    const date = new Date(year, month, day);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return date < todayStart;
  };

  // Generate calendar days
  const calendarDays = [];
  
  // Previous month days
  for (let i = firstDayOfMonth - 1; i >= 0; i--) {
    calendarDays.push({
      day: daysInPrevMonth - i,
      isCurrentMonth: false,
      isPast: true
    });
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push({
      day,
      isCurrentMonth: true,
      isPast: isPastDate(day)
    });
  }

  // Next month days to fill the grid
  const remainingDays = 42 - calendarDays.length;
  for (let day = 1; day <= remainingDays; day++) {
    calendarDays.push({
      day,
      isCurrentMonth: false,
      isPast: false
    });
  }

  return (
    <div className="w-[320px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={handlePrevMonth}
          className="grid size-8 place-items-center rounded-lg text-black transition hover:bg-slate-100"
        >
          <ChevronLeft className="size-5" />
        </button>
        <div className="text-sm font-semibold text-black">
          {MONTHS[month]} {year}
        </div>
        <button
          onClick={handleNextMonth}
          className="grid size-8 place-items-center rounded-lg text-black transition hover:bg-slate-100"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>

      {/* Days of week */}
      <div className="mb-2 grid grid-cols-7 gap-1">
        {DAYS.map((day) => (
          <div
            key={day}
            className="text-center text-xs font-medium text-black"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div 
        className="grid grid-cols-7 gap-1"
        onMouseLeave={() => {
          if (isDragging) {
            setIsDragging(false);
          }
        }}
      >
        {calendarDays.map((item, index) => {
          const isCurrentMonth = item.isCurrentMonth;
          const day = item.day;
          const isPast = item.isPast;
          const todayDate = isToday(day) && isCurrentMonth;
          const selectedDate = isSelected(day) && isCurrentMonth;
          const inDragRange = isInDragRange(day) && isCurrentMonth;
          const rangeStart = isRangeStart(day) && isCurrentMonth;
          const rangeEnd = isRangeEnd(day) && isCurrentMonth;

          return (
            <button
              key={index}
              onClick={() => isCurrentMonth && !isPast && handleDateClick(day)}
              onMouseDown={() => !isTouchDevice && isCurrentMonth && !isPast && handleMouseDown(day)}
              onMouseEnter={() => !isTouchDevice && isCurrentMonth && !isPast && handleMouseEnter(day)}
              onMouseUp={() => !isTouchDevice && isCurrentMonth && !isPast && handleMouseUp(day)}
              disabled={!isCurrentMonth || isPast}
              className={`
                grid size-9 place-items-center rounded-lg text-sm transition select-none
                ${!isCurrentMonth ? "text-slate-300" : ""}
                ${isPast && isCurrentMonth ? "text-black/35 cursor-not-allowed" : ""}
                ${!isPast && isCurrentMonth ? "text-black hover:bg-[color:var(--brand-mist)] cursor-pointer" : ""}
                ${todayDate && !selectedDate && !inDragRange && !rangeStart && !rangeEnd ? "border-2 border-[color:var(--brand-green)] text-black font-semibold" : ""}
                ${selectedDate && mode === "single" ? "bg-[color:var(--brand-green)] text-white font-semibold hover:bg-[color:var(--brand-green)]/90" : ""}
                ${inDragRange && mode === "range" && !rangeStart && !rangeEnd ? "bg-[color:var(--brand-mist)]/70 text-black" : ""}
                ${(rangeStart || rangeEnd) && mode === "range" ? "bg-[color:var(--brand-green)] text-white font-semibold hover:bg-[color:var(--brand-green)]/90" : ""}
                ${rangeStart && mode === "range" ? "rounded-r-none" : ""}
                ${rangeEnd && mode === "range" && dragStart && dragEnd && dragStart.getTime() !== dragEnd.getTime() ? "rounded-l-none" : ""}
              `}
            >
              {day}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-4 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (mode === "range") {
              onSelect({ from: today, to: today });
            } else {
              onSelect(today);
            }
            if (onClose) onClose();
          }}
          className="flex-1 border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          Today
        </Button>
        {onClose && (
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="flex-1 border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            Close
          </Button>
        )}
      </div>
    </div>
  );
}
