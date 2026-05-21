import { useNavigate } from 'react-router-dom';
import { Home, RefreshCw, WifiOff } from 'lucide-react';

export default function NetworkErrorPage() {
  const navigate = useNavigate();

  const handleRefresh = () => {
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
      <div className="max-w-md w-full text-center">
        {/* Network Error Illustration */}
        <div className="mb-8">
          <div className="w-32 h-32 mx-auto bg-[#dbeafe] rounded-full flex items-center justify-center">
            <WifiOff size={64} className="text-[#2563eb]" strokeWidth={1.5} />
          </div>
        </div>

        {/* Content */}
        <h2 className="text-3xl font-bold text-[#1e293b] mb-3">
          No Internet Connection
        </h2>
        <p className="text-[#64748b] mb-8">
          Please check your internet connection and try again. 
          Make sure you're connected to a network.
        </p>

        {/* Troubleshooting Tips */}
        <div className="bg-white rounded-lg border border-[#eaeaea] p-4 mb-8 text-left">
          <h3 className="text-sm font-semibold text-[#1e293b] mb-2">
            Troubleshooting Tips:
          </h3>
          <ul className="text-sm text-[#64748b] space-y-1">
            <li>• Check your Wi-Fi or mobile data connection</li>
            <li>• Try turning airplane mode on and off</li>
            <li>• Restart your router or modem</li>
            <li>• Check if other websites are loading</li>
          </ul>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={handleRefresh}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
          >
            <RefreshCw size={16} />
            Try Again
          </button>
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center gap-2 px-6 py-3 border border-[#eaeaea] text-[#1e293b] rounded-lg text-sm font-medium hover:bg-[#f8fafc] transition-colors"
          >
            <Home size={16} />
            Go Home
          </button>
        </div>
      </div>
    </div>
  );
}
