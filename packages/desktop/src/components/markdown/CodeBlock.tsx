import { useState, type ReactNode } from 'react';

interface CodeBlockProps {
  children: ReactNode;
  className?: string;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  // Extract language from className (e.g., "language-javascript")
  const language = className?.replace(/language-/, '') || 'code';

  const handleCopy = async () => {
    // Extract text from children - handle multiple types
    let codeText = '';
    
    if (typeof children === 'string') {
      codeText = children;
    } else if (Array.isArray(children)) {
      // Handle array of children (e.g., multiple lines as separate elements)
      codeText = children.map(child => {
        if (typeof child === 'string') return child;
        if (child && typeof child === 'object' && 'props' in child) {
          const propChild = child as React.ReactElement;
          return typeof propChild.props?.children === 'string' 
            ? propChild.props.children 
            : '';
        }
        return '';
      }).join('');
    } else if (children && typeof children === 'object' && 'props' in children) {
      // Handle ReactElement
      const codeElement = children as React.ReactElement;
      codeText = typeof codeElement.props?.children === 'string'
        ? codeElement.props.children
        : '';
    }

    if (!codeText) {
      console.error('Failed to extract code text');
      return;
    }

    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="relative group">
      {/* Header with language and copy button */}
      <div className="absolute top-2 right-2 flex items-center gap-2 z-10">
        <span className="text-xs text-gray-400 bg-gray-700/50 px-2 py-0.5 rounded backdrop-blur-sm">
          {language}
        </span>
        <button
          onClick={handleCopy}
          className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-700/50"
          title="Copy code"
        >
          {copied ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>
      {/* Code content */}
      <pre className="!mt-0 !rounded-lg overflow-x-auto">
        <code className={className}>
          {children}
        </code>
      </pre>
    </div>
  );
}
