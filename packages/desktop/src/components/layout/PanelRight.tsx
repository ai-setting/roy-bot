/**
 * PanelRight - Detail panel (placeholder)
 * Task 2: Basic layout panels
 * 
 * This panel displays task/event details
 */
import { useUIStore } from '@/stores/uiStore';

export function PanelRight() {
  const { selectedTaskId, selectedEventId } = useUIStore();

  return (
    <div 
      data-testid="panel"
      data-default-size={40}
      className="w-full h-full bg-[#16162a] flex flex-col border-l border-[#2d2d44]"
    >
      {/* Panel Header */}
      <div className="h-10 px-4 flex items-center border-b border-[#2d2d44] bg-[#1a1a2e]">
        <h2 className="text-sm font-medium text-surface-300">📋 Details</h2>
      </div>

      {/* Panel Content */}
      <div className="flex-1 p-4 overflow-auto">
        {selectedTaskId ? (
          <div className="text-surface-400 text-sm">
            <h3 className="text-surface-300 font-medium mb-2">Task Details</h3>
            <p>Task ID: {selectedTaskId}</p>
            <p className="mt-4 text-surface-500">Detail view coming soon...</p>
          </div>
        ) : selectedEventId ? (
          <div className="text-surface-400 text-sm">
            <h3 className="text-surface-300 font-medium mb-2">Event Details</h3>
            <p>Event ID: {selectedEventId}</p>
            <p className="mt-4 text-surface-500">Detail view coming soon...</p>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-surface-500 text-sm mb-2">
                No selection
              </p>
              <p className="text-surface-600 text-xs">
                Select a task or event to view details
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
