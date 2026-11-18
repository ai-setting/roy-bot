import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // Code block - use custom CodeBlock component
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="bg-gray-700 px-1 rounded text-xs font-mono"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <CodeBlock className={className}>
              {children}
            </CodeBlock>
          );
        },
        // Paragraph
        p: ({ children }) => (
          <p className="my-2 leading-relaxed">{children}</p>
        ),
        // Headings
        h1: ({ children }) => (
          <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 className="text-sm font-semibold mt-2 mb-1">{children}</h4>
        ),
        // Lists
        ul: ({ children }) => (
          <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="text-surface-200">{children}</li>
        ),
        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-[#6c63ff] pl-3 italic text-gray-400 my-2">
            {children}
          </blockquote>
        ),
        // Links
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-[#6c63ff] hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        // Images
        img: ({ src, alt }) => (
          <img
            src={src}
            alt={alt}
            className="max-w-full rounded-lg my-2"
            loading="lazy"
          />
        ),
        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-3">
            <table className="w-full border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-gray-700">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="p-2 text-left border border-gray-600">{children}</th>
        ),
        td: ({ children }) => (
          <td className="p-2 border border-gray-600">{children}</td>
        ),
        // Horizontal rule
        hr: () => <hr className="border-gray-600 my-4" />,
        // Task list checkboxes
        input: ({ type, checked, ...props }) => {
          if (type === 'checkbox') {
            return (
              <input
                type="checkbox"
                checked={checked}
                readOnly
                className="mr-2 accent-[#6c63ff]"
                {...props}
              />
            );
          }
          return <input type={type} {...props} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
