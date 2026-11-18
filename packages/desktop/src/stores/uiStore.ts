/**
 * UI Store - Zustand store for UI state management
 * Task 2: Basic layout panels - UI state management
 */
import { create } from 'zustand';

export type MenuType = 'tasks' | 'chat' | 'files' | 'settings';

interface UIState {
  menuCollapsed: boolean;
  activeMenu: MenuType;
  selectedEventId: string | null;
  selectedTaskId: number | null;
  panelSizes: [number, number, number]; // [L2, Center, Right] percentages
}

interface UIActions {
  toggleMenu: () => void;
  setMenuCollapsed: (collapsed: boolean) => void;
  setActiveMenu: (menu: MenuType) => void;
  setSelectedTaskId: (taskId: number | null) => void;
  setSelectedEventId: (eventId: string | null) => void;
  setPanelSizes: (sizes: [number, number, number]) => void;
}

export type UIStore = UIState & UIActions;

// Create the store
const store = create<UIStore>((set) => ({
  // Initial state
  menuCollapsed: false,
  activeMenu: 'tasks',
  selectedEventId: null,
  selectedTaskId: null,
  panelSizes: [30, 30, 40],

  // Actions
  toggleMenu: () => set((state) => ({ menuCollapsed: !state.menuCollapsed })),
  
  setMenuCollapsed: (collapsed: boolean) => set({ menuCollapsed: collapsed }),
  
  setActiveMenu: (menu: MenuType) => set({ activeMenu: menu }),
  
  setSelectedTaskId: (taskId: number | null) => set({ selectedTaskId: taskId }),
  
  setSelectedEventId: (eventId: string | null) => set({ selectedEventId: eventId }),
  
  setPanelSizes: (sizes: [number, number, number]) => set({ panelSizes: sizes }),
}));

// Export as both hook (for React components) and store (for tests)
export const useUIStore = store;
// For backward compatibility with tests
export const uiStore = store;
