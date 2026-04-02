"use client";

import Markdown from "react-markdown";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={`markdown-content ${className ?? ""}`}>
      <Markdown
        components={{
          p: ({ children }) => (
            <p className="mb-2 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          code: ({ children, className: codeClassName }) => {
            const isBlock = codeClassName?.startsWith("language-");
            if (isBlock) {
              return (
                <code className="block bg-black/5 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto mb-2 last:mb-0">
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-black/5 rounded px-1 py-0.5 text-xs font-mono">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
          h1: ({ children }) => (
            <p className="font-bold text-base mb-1">{children}</p>
          ),
          h2: ({ children }) => (
            <p className="font-bold mb-1">{children}</p>
          ),
          h3: ({ children }) => (
            <p className="font-semibold mb-1">{children}</p>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-current/20 pl-3 opacity-80 mb-2 last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-current/10 my-2" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
