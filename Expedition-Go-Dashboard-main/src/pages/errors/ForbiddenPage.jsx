import { useNavigate } from 'react-router-dom';
import { Home, ArrowLeft, ShieldAlert } from 'lucide-react';

export default function ForbiddenPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
      <div className="max-w-md w-full text-center">
        {/* 403 Illustration */}
        <div className="mb-8">
          <h1 className="text-9xl font-bold text-[#f97316] opacity-20">403</h1>
          <div className="relative -mt-16">
            <div className="w-32 h-32 mx-auto bg-[#ffedd5] rounded-full flex items-center justify-center">
              <ShieldAlert size={64} className="text-[#f97316]" strokeWidth={1.5} />
            </div>
          </div>
        </div>

        {/* Content */}
        <h2 className="text-3xl font-bold text-[#1e293b] mb-3">
          Access Denied
        </h2>
        <p className="text-[#64748b] mb-8">
          You don't have permission to access this resource. 
          Please contact your administrator if you believe this is an error.
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
          Need access? <a href="/support" className="text-[#044b3b] hover:underline">Request Permission</a>
        </p>
      </div>
    </div>
  );
}
