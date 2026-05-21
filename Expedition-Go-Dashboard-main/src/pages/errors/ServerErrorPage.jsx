import { useNavigate } from 'react-router-dom';
import { Home, RefreshCw, ServerCrash } from 'lucide-react';

export default function ServerErrorPage() {
  const navigate = useNavigate();

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
      <div className="max-w-md w-full text-center">
        {/* 500 Illustration */}
        <div className="mb-8">
          <h1 className="text-9xl font-bold text-[#dc2626] opacity-20">500</h1>
          <div className="relative -mt-16">
            <div className="w-32 h-32 mx-auto bg-[#fee2e2] rounded-full flex items-center justify-center">
              <ServerCrash size={64} className="text-[#dc2626]" strokeWidth={1.5} />
            </div>
          </div>
        </div>

        {/* Content */}
        <h2 className="text-3xl font-bold text-[#1e293b] mb-3">
          Server Error
        </h2>
        <p className="text-[#64748b] mb-8">
          Oops! Something went wrong on our end. 
          Our team has been notified and is working to fix the issue.
        </p>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={handleRefresh}
            className="flex items-center justify-center gap-2 px-6 py-3 border border-[#eaeaea] text-[#1e293b] rounded-lg text-sm font-medium hover:bg-[#f8fafc] transition-colors"
          >
            <RefreshCw size={16} />
            Try Again
          </button>
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
          >
            <Home size={16} />
            Go Home
          </button>
        </div>

        {/* Help Text */}
        <p className="mt-8 text-sm text-[#9e9e9e]">
          If the problem persists, please <a href="/support" className="text-[#044b3b] hover:underline">contact support</a>
        </p>
      </div>
    </div>
  );
}
