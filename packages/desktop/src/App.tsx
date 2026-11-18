/**
 * Roy Agent Desktop - Main App Component
 * Task-first personal assistant using Tauri 2.x + React + TypeScript
 * 
 * Layout:
 * ┌──────────────────────────────────────────────────────────────┐
 * │                      TitleBar                                │
 * ├────────┬─────────────────────────────────────────────────────┤
 * │        │  ┌──────────┬──────────┬──────────────────────────┐ │
 * │        │  │  PanelL2 │  Panel   │      PanelRight         │ │
 * │ PanelL1│  │  (Chat)  │  Center  │      (Details)          │ │
 * │ (Menu) │  │   30%    │  (Events)│                         │ │
 * │        │  │          │   30%    │        40%              │ │
 * │        │  │          │          │                         │ │
 * │        │  └──────────┴──────────┴──────────────────────────┘ │
 * │        │                                                     │
 * ├────────┴─────────────────────────────────────────────────────┤
 * │                      StatusBar                               │
 * └──────────────────────────────────────────────────────────────┘
 */
import { TitleBar } from './components/layout/TitleBar';
import { PanelL1 } from './components/layout/PanelL1';
import { SplitPanes } from './components/layout/SplitPanes';
import { StatusBar } from './components/layout/StatusBar';
import { DesktopEnvironmentProvider } from './contexts/DesktopEnvironmentContext';
import { HelloWorld } from './components/HelloWorld';

function App() {
  return (
    <DesktopEnvironmentProvider>
      <div 
        data-testid="app-container"
        className="h-screen w-screen flex flex-col bg-[#0f0f1a] text-white overflow-hidden"
      >
        {/* Title Bar - Window controls */}
        <TitleBar />

        {/* Main Content Area */}
        <div 
          data-testid="content-area"
          className="flex-1 flex overflow-hidden"
        >
          {/* Panel L1 - Left Sidebar Menu */}
          <PanelL1 />

          {/* Main Content - Split Panes */}
          <SplitPanes />
        </div>

        {/* Status Bar */}
        <StatusBar />
      </div>
    </DesktopEnvironmentProvider>
  );
}

// 临时：Hello World 示例
// import { HelloWorld } from './components/HelloWorld';
// function App() {
//   return <HelloWorld />;
// }

export default App;
