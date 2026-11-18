/**
 * PanelCenter - Events panel
 * Task 2: Basic layout panels
 * 
 * This panel displays events/workflow events in a list format.
 * Uses eventStore for real-time event updates.
 */
import { useEffect, useState } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useEventStore, DesktopEvent } from '@/stores/eventStore';

// Event type colors for visual distinction
const EVENT_TYPE_COLORS: Record<string, string> = {
  'workflow.start': 'text-green-400',
  'workflow.complete': 'text-blue-400',
  'workflow.error': 'text-red-400',
  'workflow.pause': 'text-yellow-400',
  'node.start': 'text-cyan-400',
  'node.complete': 'text-indigo-400',
  'node.error': 'text-red-500',
  'tool.call': 'text-purple-400',
  'tool.result': 'text-pink-400',
  'session.start': 'text-emerald-400',
  'session.end': 'text-teal-400',
  'default': 'text-surface-400',
};

/**
 * Format timestamp to readable time
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Get color class for event type
 */
function getEventColor(type: string): string {
  return EVENT_TYPE_COLORS[type] || EVENT_TYPE_COLORS['default'];
}

/**
 * EventCard - Individual event display
 */
function EventCard({ 
  event, 
  isSelected, 
  onClick 
}: { 
  event: DesktopEvent; 
  isSelected: boolean;
  onClick: () => void;
}) {
  const colorClass = getEventColor(event.type);
  
  // Safe data display
  const getDataPreview = (data: unknown): string => {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data.slice(0, 50);
    try {
      const json = JSON.stringify(data);
      return json.length > 50 ? json.slice(0, 50) + '...' : json;
    } catch {
      return String(data).slice(0, 50);
    }
  };
  
  return (
    <div
      onClick={onClick}
      className={`
        p-3 rounded-lg cursor-pointer transition-all border
        ${isSelected 
          ? 'bg-[#2a2a4a] border-[#6c63ff]' 
          : 'bg-[#16162a] border-[#2d2d44] hover:border-[#4d4d64]'
        }
      `}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-medium ${colorClass}`}>
          {event.type}
        </span>
        <span className="text-xs text-surface-500">
          {formatTime(event.timestamp)}
        </span>
      </div>
      {event.data !== undefined && (
        <div className="text-xs text-surface-400 mt-1 truncate">
          {getDataPreview(event.data)}
        </div>
      )}
    </div>
  );
}

/**
 * EventDetail - Shows selected event details in a modal or side panel
 */
function EventDetail({ event, onClose }: { event: DesktopEvent | null; onClose: () => void }) {
  if (!event) {
    return null;
  }

  return (
    <div className="p-4 space-y-3 border-t border-[#2d2d44]">
      <div className="flex items-center justify-between">
        <label className="text-xs text-surface-500 uppercase tracking-wide">事件详情</label>
        <button 
          onClick={onClose}
          className="text-surface-500 hover:text-surface-300 text-lg leading-none"
        >
          ×
        </button>
      </div>
      
      <div>
        <label className="text-xs text-surface-500 uppercase tracking-wide">类型</label>
        <p className={`text-sm font-medium mt-1 ${getEventColor(event.type)}`}>
          {event.type}
        </p>
      </div>
      
      <div>
        <label className="text-xs text-surface-500 uppercase tracking-wide">时间</label>
        <p className="text-sm text-surface-300 mt-1">
          {new Date(event.timestamp).toLocaleString('zh-CN')}
        </p>
      </div>
      
      <div>
        <label className="text-xs text-surface-500 uppercase tracking-wide">数据</label>
        <pre className="mt-1 p-3 bg-[#0f0f1a] rounded text-xs text-surface-400 overflow-auto max-h-48">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </div>
    </div>
  );
}

/**
 * PanelCenter - Main events panel
 */
export function PanelCenter() {
  const { activeMenu } = useUIStore();
  const { events, isSubscribed, subscribe, clearEvents } = useEventStore();
  const { selectedEventId, setSelectedEventId } = useUIStore();
  
  // Filter state
  const [filterType, setFilterType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  
  // Subscribe to event bus on mount
  useEffect(() => {
    const unsubscribe = subscribe();
    return () => {
      unsubscribe();
    };
  }, [subscribe]);
  
  // Filter events based on type and search
  const filteredEvents = events.filter(event => {
    // Type filter
    if (filterType !== 'all' && event.type !== filterType) {
      return false;
    }
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const typeMatch = event.type.toLowerCase().includes(query);
      const dataMatch = event.data && JSON.stringify(event.data).toLowerCase().includes(query);
      return typeMatch || dataMatch;
    }
    return true;
  });
  
  // Get unique event types for filter dropdown
  const eventTypes = Array.from(new Set(events.map(e => e.type)));
  
  // Selected event
  const selectedEvent = selectedEventId 
    ? events.find(e => e.timestamp.toString() === selectedEventId || e.type === selectedEventId)
    : null;

  if (activeMenu !== 'tasks') {
    return (
      <div 
        data-testid="panel"
        data-default-size={30}
        className="w-full h-full bg-[#1a1a2e] flex flex-col"
      >
        <div className="h-10 px-4 flex items-center border-b border-[#2d2d44] bg-[#16162a]">
          <h2 className="text-sm font-medium text-surface-300">🎯 Events</h2>
        </div>
        <div className="h-full flex items-center justify-center">
          <p className="text-surface-500 text-sm">
            Select "🎯 Tasks" from the menu to view events
          </p>
        </div>
      </div>
    );
  }

  return (
    <div 
      data-testid="panel"
      data-default-size={30}
      className="w-full h-full bg-[#1a1a2e] flex flex-col"
    >
      {/* Panel Header */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-[#2d2d44] bg-[#16162a]">
        <h2 className="text-sm font-medium text-surface-300">
          🎯 Events {isSubscribed && <span className="text-green-400 text-xs ml-1">●</span>}
        </h2>
        <span className="text-xs text-surface-500">
          {filteredEvents.length} / {events.length}
        </span>
      </div>
      
      {/* Filters */}
      <div className="px-4 py-2 border-b border-[#2d2d44] space-y-2">
        {/* Search */}
        <input
          type="text"
          placeholder="搜索事件..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-1.5 text-xs bg-[#0f0f1a] border border-[#2d2d44] rounded text-surface-300 placeholder-surface-500 focus:outline-none focus:border-[#6c63ff]"
        />
        
        {/* Type Filter */}
        <div className="flex gap-2">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="flex-1 px-2 py-1.5 text-xs bg-[#0f0f1a] border border-[#2d2d44] rounded text-surface-300 focus:outline-none focus:border-[#6c63ff]"
          >
            <option value="all">所有类型</option>
            {eventTypes.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          
          <button
            onClick={clearEvents}
            className="px-2 py-1.5 text-xs bg-[#2d2d44] hover:bg-[#3d3d54] rounded text-surface-300 transition-colors"
            title="清空事件"
          >
            🗑️
          </button>
        </div>
      </div>
      
      {/* Events List */}
      <div className="flex-1 overflow-auto">
        {filteredEvents.length === 0 ? (
          <div className="h-full flex items-center justify-center text-surface-500 text-sm">
            {events.length === 0 
              ? '暂无事件，稍后将会显示...'
              : '没有匹配的事件'
            }
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {filteredEvents.map((event, index) => (
              <EventCard
                key={`${event.timestamp}-${index}`}
                event={event}
                isSelected={selectedEventId === `${event.timestamp}`}
                onClick={() => setSelectedEventId(`${event.timestamp}`)}
              />
            ))}
          </div>
        )}
      </div>
      
      {/* Event Detail */}
      <EventDetail 
        event={selectedEvent ?? null} 
        onClose={() => setSelectedEventId(null)} 
      />
    </div>
  );
}
