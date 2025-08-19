import React, { ReactNode } from "react";

export type StepStatus = "pending" | "active" | "complete";

export interface StepProps {
  stepNumber: number;
  title: string;
  status: StepStatus;
  isExpanded: boolean;
  onToggle?: () => void;
  children: ReactNode;
}

export const StepContainer: React.FC<StepProps> = ({
  stepNumber,
  title,
  status,
  isExpanded,
  onToggle,
  children,
}) => {
  const getStatusStyles = () => {
    switch (status) {
      case "active":
        return "border-2 border-indigo-500 bg-gradient-to-r from-indigo-50 to-blue-50 shadow-lg";
      case "complete":
        return "border-2 border-green-400 bg-gradient-to-r from-green-50 to-emerald-50";
      default:
        return "border-2 border-gray-200 bg-white";
    }
  };

  const getIconStyles = () => {
    switch (status) {
      case "active":
        return "bg-indigo-600 text-white";
      case "complete":
        return "bg-green-500 text-white";
      default:
        return "bg-gray-300 text-gray-600";
    }
  };

  const getConnectorStyles = () => {
    switch (status) {
      case "complete":
        return "bg-green-500";
      case "active":
        return "bg-indigo-500";
      default:
        return "bg-gray-300";
    }
  };

  return (
    <div className="relative mb-6">
      {/* Connector line to next step */}
      {stepNumber < 3 && (
        <div
          className={`absolute left-8 top-20 w-1 h-12 ${getConnectorStyles()} rounded-full`}
        />
      )}
      
      <div
        className={`rounded-2xl p-6 transition-all duration-300 ${getStatusStyles()}`}
      >
        <button
          onClick={onToggle}
          className="w-full flex items-center gap-4 text-left group"
          type="button"
        >
          <div
            className={`flex-shrink-0 w-16 h-16 rounded-full flex items-center justify-center font-bold text-lg transition-transform group-hover:scale-105 ${getIconStyles()}`}
          >
            {status === "complete" ? (
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              stepNumber
            )}
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-xl text-gray-900">{title}</h3>
            {status === "complete" && !isExpanded && (
              <p className="text-sm text-green-600 mt-1 font-medium">✓ Completed successfully</p>
            )}
            {status === "active" && (
              <p className="text-sm text-indigo-600 mt-1 font-medium animate-pulse">● In progress...</p>
            )}
            {status === "pending" && (
              <p className="text-sm text-gray-400 mt-1">Waiting to start</p>
            )}
          </div>
          <svg
            className={`w-6 h-6 text-gray-400 transition-transform duration-200 ${
              isExpanded ? "rotate-180" : ""
            }`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        
        {isExpanded && (
          <div className="mt-6 pl-20 pr-4">
            <div className="border-l-2 border-gray-200 pl-6">
              {children}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};