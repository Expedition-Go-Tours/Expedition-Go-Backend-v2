import React from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import config from '@/config';

/**
 * Error Boundary Component
 * Catches JavaScript errors anywhere in the child component tree
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorCount: 0,
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error to console in development
    if (config.isDevelopment()) {
      console.error('Error Boundary caught an error:', error, errorInfo);
    }

    // Log error to monitoring service (Sentry, etc.)
    this.logErrorToService(error, errorInfo);

    // Update state with error details
    this.setState((prevState) => ({
      error,
      errorInfo,
      errorCount: prevState.errorCount + 1,
    }));
  }

  logErrorToService = (error, errorInfo) => {
    // TODO: Integrate with error monitoring service (Sentry, LogRocket, etc.)
    if (config.monitoring.sentryDSN) {
      // Example: Sentry.captureException(error, { extra: errorInfo });
      console.log('📊 Logging error to monitoring service:', error.message);
    }
  };

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback({
          error: this.state.error,
          errorInfo: this.state.errorInfo,
          resetError: this.handleReset,
        });
      }

      // Default fallback UI
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
          <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-6 md:p-8">
            {/* Icon */}
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-[#fee2e2] rounded-full flex items-center justify-center">
                <AlertTriangle size={32} className="text-[#dc2626]" />
              </div>
            </div>

            {/* Title */}
            <h1 className="text-2xl font-bold text-[#1e293b] text-center mb-2">
              Oops! Something went wrong
            </h1>

            {/* Description */}
            <p className="text-sm text-[#64748b] text-center mb-6">
              {this.props.errorMessage || 
                "We're sorry, but something unexpected happened. Please try refreshing the page or go back to the homepage."}
            </p>

            {/* Error details (development only) */}
            {config.isDevelopment() && this.state.error && (
              <div className="mb-6 p-4 bg-[#f8fafc] rounded-lg border border-[#eaeaea]">
                <p className="text-xs font-mono text-[#dc2626] mb-2">
                  {this.state.error.toString()}
                </p>
                {this.state.errorInfo && (
                  <details className="text-xs font-mono text-[#64748b]">
                    <summary className="cursor-pointer hover:text-[#1e293b]">
                      Stack trace
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </details>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={this.handleReset}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#044b3b] text-white rounded-lg text-sm font-medium hover:bg-[#033629] transition-colors"
              >
                <RefreshCw size={16} />
                Try Again
              </button>
              <button
                onClick={this.handleGoHome}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-[#eaeaea] text-[#1e293b] rounded-lg text-sm font-medium hover:bg-[#f8fafc] transition-colors"
              >
                <Home size={16} />
                Go Home
              </button>
            </div>

            {/* Error count warning */}
            {this.state.errorCount > 2 && (
              <div className="mt-4 p-3 bg-[#fef3c7] border border-[#fbbf24] rounded-lg">
                <p className="text-xs text-[#92400e] text-center">
                  This error has occurred {this.state.errorCount} times. 
                  Please contact support if the problem persists.
                </p>
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
