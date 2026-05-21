import WizardProgressBar from "./WizardProgressBar";
import WizardNavFooter from "./WizardNavFooter";

export default function WizardStepLayout({ children, title, description }) {
  return (
    <div className="max-w-5xl mx-auto">
      {/* Progress Bar */}
      <div className="bg-white rounded-lg border border-[#eaeaea] p-4 md:p-6 mb-4 md:mb-6 overflow-x-auto">
        <WizardProgressBar />
      </div>

      {/* Step Content */}
      <div className="bg-white rounded-lg border border-[#eaeaea]">
        {/* Step Header */}
        <div className="px-4 md:px-6 py-3 md:py-4 border-b border-[#eaeaea]">
          <h2 className="text-base md:text-lg font-semibold text-[#1e293b]">{title}</h2>
          {description && (
            <p className="text-sm text-[#64748b] mt-1">{description}</p>
          )}
        </div>

        {/* Step Body */}
        <div className="p-4 md:p-6">{children}</div>

        {/* Step Footer */}
        <div className="px-4 md:px-6 py-3 md:py-4 border-t border-[#eaeaea]">
          <WizardNavFooter />
        </div>
      </div>
    </div>
  );
}
