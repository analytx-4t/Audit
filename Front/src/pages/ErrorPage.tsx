// pages/ErrorPage.tsx
import { Link, useRouteError } from "react-router-dom";

const ErrorPage = () => {
  const error: any = useRouteError();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 shadow-xl rounded-2xl p-8 text-center">
        
        {/* Icon */}
        <div className="flex justify-center mb-6">
          <div className="h-16 w-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
            <span className="text-red-600 dark:text-red-400 text-3xl">⚠️</span>
          </div>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100 mb-2">
          Oops!
        </h1>

        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Something went wrong. Please try again later.
        </p>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg p-3 mb-6 break-words">
            {error?.statusText || error?.message}
          </div>
        )}

        {/* Action */}
        <Link
          to="/"
          className="inline-flex items-center justify-center w-full px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition"
        >
          Go to Login
        </Link>
      </div>
    </div>
  );
};

export default ErrorPage;
