import React from 'react';
import { useConversationStore } from '../stores/conversation.store.js';
import { useUIStore } from '../stores/ui.store.js';

export const EventLog: React.FC = () => {
  const events = useConversationStore(state => state.events);
  const clearEvents = useConversationStore(state => state.clearEvents);
  const eventLogMinimized = useUIStore(state => state.eventLogMinimized);
  const toggleEventLog = useUIStore(state => state.toggleEventLog);
  
  const recentEvents = events.slice(-20);
  
  return (
    <div className={`event-log ${eventLogMinimized ? 'minimized' : ''}`}>
      <div className="event-log-header">
        <span>Event Log ({events.length})</span>
        <div className="event-log-controls">
          <button onClick={clearEvents} title="Clear events">🗑️</button>
          <button onClick={toggleEventLog} title={eventLogMinimized ? 'Expand' : 'Minimize'}>
            {eventLogMinimized ? '⬆' : '⬇'}
          </button>
        </div>
      </div>
      
      {!eventLogMinimized && (
        <div className="event-log-content">
          {recentEvents.length === 0 ? (
            <div className="event-log-empty">No events yet</div>
          ) : (
            recentEvents.map(event => (
              <div key={event.id} className={`event-log-entry ${event.type}`}>
                <span className="event-time">
                  {event.timestamp.toLocaleTimeString()}
                </span>
                <span className="event-message">{event.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};