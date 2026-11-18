/**
 * StatusBar - Bottom status bar
 * Task 2: Basic layout panels
 * 
 * Displays application status, connection info, etc.
 */
import { useState, useEffect } from 'react';

export function StatusBar() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div 
      data-testid="status-bar"
      className="h-6 bg-[#1a1a2e] border-t border-[#2d2d44] px-4 flex items-center justify-between text-xs text-surface-500"
    >
      {/* Left side - App info */}
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-500"></span>
          Ready
        </span>
        <span>Roy Agent Desktop v0.1.0</span>
      </div>

      {/* Right side - Status info */}
      <div className="flex items-center gap-4">
        <span>{time.toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
