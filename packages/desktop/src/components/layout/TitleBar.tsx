/**
 * TitleBar Component - Window controls (minimize/maximize/close)
 * 
 * Adapted for Electron - uses electronAPI instead of Tauri
 */
import { useEffect, useState } from 'react';
import { isElectron, getElectronAPI } from '../../electron';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isElectronEnv, setIsElectronEnv] = useState(false);

  useEffect(() => {
    setIsElectronEnv(isElectron());
    
    if (!isElectron()) {
      return;
    }

    const checkMaximized = async () => {
      try {
        const api = getElectronAPI();
        const maximized = await api.isWindowMaximized();
        setIsMaximized(maximized);
      } catch (error) {
        console.error('Failed to check window state:', error);
      }
    };

    checkMaximized();

    // Listen for window state changes
    const api = getElectronAPI();
    const unsubscribe = api.onMaximizeChange((maximized) => {
      setIsMaximized(maximized);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleMinimize = async () => {
    if (!isElectron()) return;
    try {
      const api = getElectronAPI();
      await api.minimizeWindow();
    } catch (error) {
      console.error('Failed to minimize:', error);
    }
  };

  const handleMaximize = async () => {
    if (!isElectron()) return;
    try {
      const api = getElectronAPI();
      await api.maximizeWindow();
      setIsMaximized(!isMaximized);
    } catch (error) {
      console.error('Failed to toggle maximize:', error);
    }
  };

  const handleClose = async () => {
    if (!isElectron()) return;
    try {
      const api = getElectronAPI();
      await api.closeWindow();
    } catch (error) {
      console.error('Failed to close:', error);
    }
  };

  return (
    <div 
      data-testid="title-bar"
      className="h-9 bg-[#1a1a2e] border-b border-[#2d2d44] flex items-center justify-between px-4 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* App Title */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-surface-300">Roy Agent</span>
        {!isElectronEnv && (
          <span className="text-xs text-surface-500">(Dev Mode)</span>
        )}
      </div>

      {/* Window Controls */}
      <div 
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Minimize */}
        <button
          onClick={handleMinimize}
          disabled={!isElectronEnv}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Minimize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="2" y="5.5" width="8" height="1" />
          </svg>
        </button>

        {/* Maximize/Restore */}
        <button
          onClick={handleMaximize}
          disabled={!isElectronEnv}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3" y="1" width="8" height="8" rx="1" />
              <rect x="1" y="3" width="8" height="8" rx="1" fill="#1a1a2e" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
            </svg>
          )}
        </button>

        {/* Close */}
        <button
          onClick={handleClose}
          disabled={!isElectronEnv}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-red-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
