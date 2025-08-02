import { useEffect } from 'react';
import { useConversationStore } from '../stores/conversation.store.js';

export function useHashRouter() {
  const setActiveTab = useConversationStore(state => state.setActiveTab);
  const activeTab = useConversationStore(state => state.activeTab);

  // Update URL when activeTab changes
  useEffect(() => {
    const hash = activeTab === '*' ? '#all' : `#conversation/${activeTab}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }, [activeTab]);

  // Handle hash changes (browser navigation)
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1); // Remove #
      
      if (!hash || hash === 'all') {
        setActiveTab('*');
      } else if (hash.startsWith('conversation/')) {
        const conversationId = hash.slice('conversation/'.length);
        if (conversationId) {
          setActiveTab(conversationId);
        }
      }
    };

    // Handle initial load
    handleHashChange();

    // Listen for hash changes
    window.addEventListener('hashchange', handleHashChange);
    
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [setActiveTab]);
}