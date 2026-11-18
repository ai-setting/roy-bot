/**
 * SplitPanes - Draggable resizable panels using react-resizable-panels
 * Task 2: Basic layout panels
 * 
 * Layout: [L2 (30%)] [Center (30%)] [Right (40%)]
 * Draggable borders between panels with minSize constraints
 */
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { PanelL2 } from './PanelL2';
import { PanelCenter } from './PanelCenter';
import { PanelRight } from './PanelRight';

export function SplitPanes() {
  return (
    <div data-testid="panel-group" className="flex-1 flex overflow-hidden">
      <PanelGroup direction="horizontal" className="flex-1 flex">
        {/* Panel L2 - Chat/Secondary Panel */}
        <Panel defaultSize={30} minSize={15} className="flex">
          <div data-testid="panel-l2" data-default-size={30} className="flex-1">
            <PanelL2 />
          </div>
        </Panel>

        {/* Resize Handle Between L2 and Center */}
        <PanelResizeHandle 
          data-testid="resize-handle-l2-center"
          className="w-1 bg-[#2d2d44] hover:bg-[#6c63ff] transition-colors cursor-col-resize"
        />

        {/* Panel Center - Events/Main Panel */}
        <Panel defaultSize={30} minSize={20} className="flex">
          <div data-testid="panel-center" data-default-size={30} className="flex-1">
            <PanelCenter />
          </div>
        </Panel>

        {/* Resize Handle Between Center and Right */}
        <PanelResizeHandle 
          data-testid="resize-handle-center-right"
          className="w-1 bg-[#2d2d44] hover:bg-[#6c63ff] transition-colors cursor-col-resize"
        />

        {/* Panel Right - Detail Panel */}
        <Panel defaultSize={40} minSize={20} className="flex">
          <div data-testid="panel-right" data-default-size={40} className="flex-1">
            <PanelRight />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
