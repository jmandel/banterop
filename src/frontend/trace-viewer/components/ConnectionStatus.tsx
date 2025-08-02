import React from 'react';

interface ConnectionStatusProps {
  connected: boolean;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({ connected }) => {
  return (
    <div className={`connection-status ${connected ? 'connected' : ''}`}>
      <div className="indicator"></div>
      <span>{connected ? 'Connected' : 'Disconnected'}</span>
    </div>
  );
};