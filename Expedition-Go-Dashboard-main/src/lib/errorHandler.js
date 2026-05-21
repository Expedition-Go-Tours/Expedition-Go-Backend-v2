import { toast } from 'sonner';
import config from '@/config';

/**
 * Error Types
 */
export const ErrorType = {
  NETWORK: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT_ERROR',
  AUTH: 'AUTH_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  SERVER: 'SERVER_ERROR',
  NOT_FOUND: 'NOT_FOUND_ERROR',
  FORBIDDEN: 'FORBIDDEN_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
};

/**
 * Error Messages Map
 */
const errorMessages = {
  [ErrorType.NETWORK]: 'Network error. Please check your internet connection.',
  [ErrorType.TIMEOUT]: 'Request timed out. Please try again.',
  [ErrorType.AUTH]: 'Authentication failed. Please log in again.',
  [ErrorType.VALIDATION]: 'Validation error. Please check your input.',
  [ErrorType.SERVER]: 'Server error. Please try again later.',
  [ErrorType.NOT_FOUND]: 'Resource not found.',
  [ErrorType.FORBIDDEN]: "You don't have permission to access this resource.",
  [ErrorType.UNKNOWN]: 'An unexpected error occurred.',
};

/**
 * Determine error type from axios error
 */
export function getErrorType(error) {
  if (!error.response) {
    if (error.code === 'ECONNABORTED') {
      return ErrorType.TIMEOUT;
    }
    return ErrorType.NETWORK;
  }

  const status = error.response.status;

  if (status === 401) return ErrorType.AUTH;
  if (status === 403) return ErrorType.FORBIDDEN;
  if (status === 404) return ErrorType.NOT_FOUND;
  if (status === 422) return ErrorType.VALIDATION;
  if (status >= 500) return ErrorType.SERVER;

  return ErrorType.UNKNOWN;
}

/**
 * Get user-friendly error message
 */
export function getErrorMessage(error) {
  const errorType = getErrorType(error);
  
  // Try to get message from response
  const responseMessage = 
    error.response?.data?.message ||
    error.response?.data?.error ||
    error.message;

  // Return custom message or default
  return responseMessage || errorMessages[errorType];
}

/**
 * Handle API Error
 * Shows toast notification and logs error
 */
export function handleApiError(error, customMessage) {
  const errorType = getErrorType(error);
  const message = customMessage || getErrorMessage(error);

  // Log error in development
  if (config.isDevelopment()) {
    console.error('API Error:', {
      type: errorType,
      message,
      error,
      response: error.response,
    });
  }

  // Show toast notification
  toast.error(message, {
    duration: 5000,
    action: errorType === ErrorType.NETWORK ? {
      label: 'Retry',
      onClick: () => window.location.reload(),
    } : undefined,
  });

  // Log to monitoring service
  logError(error, { type: errorType, message });

  return {
    type: errorType,
    message,
    originalError: error,
  };
}

/**
 * Log error to monitoring service
 */
export function logError(error, context = {}) {
  if (config.monitoring.sentryDSN) {
    // TODO: Integrate with Sentry or other monitoring service
    // Example: Sentry.captureException(error, { extra: context });
    console.log('📊 Logging error to monitoring service:', error.message, context);
  }
}

/**
 * Retry logic with exponential backoff
 */
export async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on certain errors
      const errorType = getErrorType(error);
      if ([ErrorType.AUTH, ErrorType.FORBIDDEN, ErrorType.VALIDATION].includes(errorType)) {
        throw error;
      }

      // Don't retry if this was the last attempt
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = baseDelay * Math.pow(2, attempt);
      
      if (config.isDevelopment()) {
        console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error) {
  const errorType = getErrorType(error);
  return [ErrorType.NETWORK, ErrorType.TIMEOUT, ErrorType.SERVER].includes(errorType);
}

/**
 * Format validation errors
 */
export function formatValidationErrors(errors) {
  if (Array.isArray(errors)) {
    return errors.map(err => err.message || err).join(', ');
  }

  if (typeof errors === 'object') {
    return Object.entries(errors)
      .map(([field, message]) => `${field}: ${message}`)
      .join(', ');
  }

  return String(errors);
}

/**
 * Global error handler for unhandled promise rejections
 */
export function setupGlobalErrorHandlers() {
  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    logError(event.reason, { type: 'unhandledRejection' });
    
    // Prevent default browser behavior
    event.preventDefault();
  });

  // Handle global errors
  window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    logError(event.error, { type: 'globalError' });
  });
}

export default {
  ErrorType,
  getErrorType,
  getErrorMessage,
  handleApiError,
  logError,
  retryWithBackoff,
  isRetryableError,
  formatValidationErrors,
  setupGlobalErrorHandlers,
};
