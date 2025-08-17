import React, { useState, useRef, useEffect } from 'react';

interface DropdownOption {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

interface DropdownButtonProps {
  label: string;
  options: DropdownOption[];
  onSelect: (value: string) => void;
  className?: string;
  buttonClassName?: string;
}

export function DropdownButton({ 
  label, 
  options, 
  onSelect, 
  className = '', 
  buttonClassName = ''
}: DropdownButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className={`relative inline-block ${className}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`inline-flex items-center justify-center gap-1 px-2 py-1 text-xs rounded-2xl ${buttonClassName}`}
        style={{ minHeight: '28px' }}
      >
        {label}
        <svg 
          className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} 
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

      {isOpen && (
        <div className="absolute right-0 z-10 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200">
          <div className="py-1">
            {options.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  if (!option.disabled) {
                    onSelect(option.value);
                    setIsOpen(false);
                  }
                }}
                className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                  option.disabled 
                    ? 'opacity-50 cursor-not-allowed bg-gray-50' 
                    : 'hover:bg-gray-50 cursor-pointer'
                }`}
                disabled={option.disabled}
              >
                <div className={`font-medium ${option.disabled ? 'text-gray-500' : 'text-gray-900'}`}>
                  {option.label} {option.disabled && '(Coming soon)'}
                </div>
                {option.description && (
                  <div className="text-xs text-gray-500 mt-0.5">{option.description}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}