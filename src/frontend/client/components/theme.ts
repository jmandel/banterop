export const theme = {
  // Spacing
  spacing: {
    section: 'p-6',
    component: 'p-4',
    compact: 'p-2',
    gap: {
      small: 'gap-2',
      medium: 'gap-4',
      large: 'gap-6'
    }
  },
  
  // Colors for step states
  stepColors: {
    pending: {
      border: 'border-gray-300',
      bg: 'bg-white',
      icon: 'bg-gray-300 text-gray-600',
      connector: 'bg-gray-300'
    },
    active: {
      border: 'border-indigo-500',
      bg: 'bg-indigo-50',
      icon: 'bg-indigo-600 text-white',
      connector: 'bg-indigo-500'
    },
    complete: {
      border: 'border-green-500',
      bg: 'bg-green-50',
      icon: 'bg-green-500 text-white',
      connector: 'bg-green-500'
    }
  },
  
  // Message styles
  messageStyles: {
    user: 'bg-indigo-600 text-white',
    planner: 'bg-white border border-gray-200',
    agent: 'bg-blue-50 text-blue-900 border-blue-200',
    system: 'text-gray-500 italic text-sm border-dashed bg-transparent'
  },
  
  // Status pills
  statusPills: {
    initializing: 'bg-gray-100 text-gray-700',
    submitted: 'bg-blue-100 text-blue-700',
    working: 'bg-yellow-100 text-yellow-700',
    'input-required': 'bg-orange-100 text-orange-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    canceled: 'bg-gray-100 text-gray-700'
  }
} as const;