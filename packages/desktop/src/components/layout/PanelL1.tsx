/**
 * PanelL1 - Left sidebar menu
 * Task 2: Basic layout panels
 * 
 * Collapsible sidebar with menu items:
 * - Tasks (primary ⭐)
 * - Chat
 * - Files
 * - Settings
 */
import { useUIStore } from '@/stores/uiStore';
import type { MenuType } from '@/stores/uiStore';

interface MenuItem {
  id: MenuType;
  icon: string;
  label: string;
  isPrimary?: boolean;
}

const menuItems: MenuItem[] = [
  { id: 'tasks', icon: '🎯', label: 'Tasks', isPrimary: true },
  { id: 'chat', icon: '💬', label: 'Chat' },
  { id: 'files', icon: '📁', label: 'Files' },
  { id: 'settings', icon: '⚙️', label: 'Settings' },
];

export function PanelL1() {
  const { menuCollapsed, activeMenu, toggleMenu, setActiveMenu } = useUIStore();

  const handleMenuClick = (menuId: MenuType) => {
    setActiveMenu(menuId);
  };

  return (
    <div 
      data-testid="sidebar-l1"
      data-collapsed={menuCollapsed}
      className={`
        h-full bg-[#1a1a2e] border-r border-[#2d2d44] 
        flex flex-col transition-all duration-200
        ${menuCollapsed ? 'w-[60px]' : 'w-[200px]'}
      `}
    >
      {/* Toggle Button */}
      <button
        onClick={toggleMenu}
        className="w-full h-12 flex items-center justify-center border-b border-[#2d2d44] hover:bg-surface-700 transition-colors"
        title={menuCollapsed ? 'Expand menu' : 'Collapse menu'}
      >
        <svg 
          width="20" 
          height="20" 
          viewBox="0 0 20 20" 
          fill="currentColor"
          className={`text-surface-400 transition-transform duration-200 ${menuCollapsed ? 'rotate-180' : ''}`}
        >
          <path d="M12.5 5L7.5 10L12.5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </button>

      {/* Menu Items */}
      <nav className="flex-1 py-2">
        {menuItems.map((item) => (
          <button
            key={item.id}
            data-testid={`menu-item-${item.id}`}
            data-active={activeMenu === item.id}
            data-primary={item.isPrimary}
            onClick={() => handleMenuClick(item.id)}
            className={`
              w-full h-12 flex items-center gap-3 px-4 
              transition-colors relative
              ${activeMenu === item.id 
                ? 'bg-[#6c63ff]/20 text-[#6c63ff]' 
                : 'text-surface-400 hover:bg-surface-700 hover:text-white'
              }
            `}
          >
            {/* Icon */}
            <span className="text-lg flex-shrink-0">{item.icon}</span>
            
            {/* Label (hidden when collapsed) */}
            <span className={`text-sm font-medium ${menuCollapsed ? 'hidden' : 'block'}`}>
              {item.label}
            </span>

            {/* Primary badge */}
            {item.isPrimary && !menuCollapsed && (
              <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-[#6c63ff]/30 text-[#6c63ff] rounded">
                ⭐
              </span>
            )}

            {/* Active indicator */}
            {activeMenu === item.id && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-[#6c63ff] rounded-r" />
            )}
          </button>
        ))}
      </nav>

      {/* Bottom section (optional user info) */}
      <div className="h-12 border-t border-[#2d2d44] flex items-center justify-center">
        <span className="text-xs text-surface-500">
          {menuCollapsed ? '👤' : 'User'}
        </span>
      </div>
    </div>
  );
}
