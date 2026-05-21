import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProductBuilderStore } from "@/features/products/stores/productBuilderStore";

export default function WizardProgressBar() {
  const { steps, currentStep, completedSteps } = useProductBuilderStore();

  return (
    <div className="w-full min-w-[600px]">
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isCompleted = completedSteps.includes(index);
          const isCurrent = currentStep === index;
          const isPending = index > currentStep && !isCompleted;
          const isClickable = isCompleted || index === currentStep || index === currentStep + 1;

          return (
            <div key={step.id} className="flex flex-1 items-center">
              {/* Step indicator */}
              <div className="flex flex-col items-center relative">
                <button
                  onClick={() => isClickable && useProductBuilderStore.getState().goToStep(index)}
                  disabled={!isClickable}
                  className={cn(
                    "w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-xs sm:text-sm font-bold transition-all duration-200 border-2",
                    isCompleted && "bg-[#044b3b] border-[#044b3b] text-white",
                    isCurrent && "bg-white border-[#044b3b] text-[#044b3b] ring-4 ring-[#044b3b]/10",
                    isPending && "bg-white border-[#eaeaea] text-[#9e9e9e]",
                    isClickable && !isCurrent && !isCompleted && "hover:border-[#044b3b] hover:text-[#044b3b] cursor-pointer"
                  )}
                >
                  {isCompleted ? <Check size={16} className="sm:w-[18px] sm:h-[18px]" /> : step.number}
                </button>
                <span
                  className={cn(
                    "mt-2 text-[10px] sm:text-xs font-medium whitespace-nowrap",
                    isCompleted && "text-[#044b3b]",
                    isCurrent && "text-[#1e293b] font-semibold",
                    isPending && "text-[#9e9e9e]"
                  )}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {index < steps.length - 1 && (
                <div className="flex-1 h-0.5 mx-1 sm:mx-2 mb-5 sm:mb-6">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      isCompleted ? "bg-[#044b3b]" : "bg-[#eaeaea]"
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
