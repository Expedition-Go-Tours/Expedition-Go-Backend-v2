import { useNavigate } from 'react-router-dom';
import { Home, ArrowLeft, Search } from 'lucide-react';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
      <div className="max-w-md w-full text-center">
        {/* 404 Illustration */}
        <div className="mb-8">
          <h1 className="text-9xl font-bold text-[#044b3b] opacity-20">404</h1>
          <div className="relative -mt-16">
            <div className="w-32 h-32 mx-auto bg-[#044b3b]/10 rounded-full flex items-center justify-center">
              <Search size={64} className="text-[#044b3b]" strokeWidth={1.5} />
            </div>
          </div>
        </div>

        {/* Content */}
        <h2 className="text-3xl font-bold text-[#1e293b] mb-3">
          Page Not Found
        </h2>
        <p className="text-[#64748b] mb-8">
          Sorry, we couldn't find the page you're looking for. 
          It might have been moved or deleted.
        </p>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center justify-center gap-2 px-6 py-3 border border-[#eaeaea] text-[#1e293b] rounded-lg text-sm font-medium hover:bg-[#f8fafc] transition-colors"
          >
            <ArrowLeft size={16} />
            Go Back
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
          Need help? <a href="/support" className="text-[#044b3b] hover:underline">Contact Support</a>
        </p>
      </div>
    </div>
  );
}
