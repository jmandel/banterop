import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  sidebarCollapsed: boolean;
  eventLogMinimized: boolean;
  wsEndpoint: string;
  apiEndpoint: string;
  
  toggleSidebar: () => void;
  toggleEventLog: () => void;
  setWsEndpoint: (endpoint: string) => void;
  setApiEndpoint: (endpoint: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      eventLogMinimized: false,
      wsEndpoint: 'ws://localhost:3001/api/ws',
      apiEndpoint: 'http://localhost:3001/api',
      
      toggleSidebar: () => set(state => ({ 
        sidebarCollapsed: !state.sidebarCollapsed 
      })),
      
      toggleEventLog: () => set(state => ({ 
        eventLogMinimized: !state.eventLogMinimized 
      })),
      
      setWsEndpoint: (endpoint: string) => set({ 
        wsEndpoint: endpoint 
      }),
      
      setApiEndpoint: (endpoint: string) => set({ 
        apiEndpoint: endpoint 
      })
    }),
    {
      name: 'trace-viewer-ui-settings'
    }
  )
);