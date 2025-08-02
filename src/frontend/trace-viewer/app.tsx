import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useWebSocketStore } from './stores/websocket.store.js';
import { useConversationStore } from './stores/conversation.store.js';
import { useUIStore } from './stores/ui.store.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { ConversationList } from './components/ConversationList.js';
import { ConversationView } from './components/ConversationView.js';
import { TabBar } from './components/TabBar.js';
import { EventLog } from './components/EventLog.js';
import './styles/global.css';
import { useHashRouter } from './hooks/useHashRouter.js';

const App: React.FC = () => {
  useHashRouter();
  const connected = useWebSocketStore(state => state.connected);
  const connect = useWebSocketStore(state => state.connect);
  const disconnect = useWebSocketStore(state => state.disconnect);
  const totalMessages = useConversationStore(state => state.totalMessages);
  const totalEvents = useConversationStore(state => state.totalEvents);
  const sidebarCollapsed = useUIStore(state => state.sidebarCollapsed);
  const toggleSidebar = useUIStore(state => state.toggleSidebar);
  const wsEndpoint = useUIStore(state => state.wsEndpoint);
  const apiEndpoint = useUIStore(state => state.apiEndpoint);
  const setWsEndpoint = useUIStore(state => state.setWsEndpoint);
  const setApiEndpoint = useUIStore(state => state.setApiEndpoint);

  useEffect(() => {
    // Auto-connect on mount
    handleConnect();
    
    // Handle unhandled promise rejections
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.warn('Unhandled promise rejection:', event.reason);
      event.preventDefault();
    };
    
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    
    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      if (connected) {
        disconnect();
      }
    };
  }, []);

  const handleConnect = async () => {
    try {
      await connect(wsEndpoint);
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
    } catch (error) {
      console.error('Failed to disconnect:', error);
    }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>Agent Conversation Monitor</h1>
        <ConnectionStatus connected={connected} />
      </header>
      
      <div className="main-layout">
        <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <button className="sidebar-toggle" onClick={toggleSidebar}>
            {sidebarCollapsed ? '→' : '←'}
          </button>
          
          <div className="sidebar-content">
            <div className="connection-controls">
              <input
                type="text"
                value={wsEndpoint}
                onChange={(e) => setWsEndpoint(e.target.value)}
                placeholder="WebSocket Endpoint"
              />
              <input
                type="text"
                value={apiEndpoint}
                onChange={(e) => setApiEndpoint(e.target.value)}
                placeholder="REST API Endpoint"
              />
              <div className="button-group">
                <button onClick={handleConnect} disabled={connected}>
                  Connect
                </button>
                <button onClick={handleDisconnect} disabled={!connected}>
                  Disconnect
                </button>
              </div>
            </div>
            
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{totalMessages}</div>
                <div className="stat-label">Messages</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{totalEvents}</div>
                <div className="stat-label">Events</div>
              </div>
            </div>
            
            <ConversationList />
          </div>
        </aside>
        
        <main className="content-area">
          <TabBar />
          <div className="tab-content">
            <ConversationView />
          </div>
        </main>
      </div>
      
      <EventLog />
    </div>
  );
};

// Bootstrap the app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}