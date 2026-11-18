import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

console.log('[Roy Agent Desktop] main.tsx loaded');
console.log('[Roy Agent Desktop] Root element:', document.getElementById('root'));

// Global error handler for uncaught exceptions
window.addEventListener('error', (event) => {
  console.error('[Roy Agent Desktop] Uncaught error:', event.error);
});

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Roy Agent Desktop] Unhandled promise rejection:', event.reason);
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('[Roy Agent Desktop] Root element not found!');
  throw new Error('Root element not found');
}

console.log('[Roy Agent Desktop] Creating React root...');
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
console.log('[Roy Agent Desktop] React root rendered');
