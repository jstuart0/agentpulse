import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils.js";

export function MarkdownContent({
	content,
	className,
	compact = false,
}: {
	content: string;
	className?: string;
	compact?: boolean;
}) {
	return (
		<div
			className={cn(
				"markdown-content break-words text-foreground",
				compact ? "text-sm leading-6" : "text-sm leading-7",
				className,
			)}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					h1: ({ node: _node, ...props }) => (
						<h1 className="mt-4 first:mt-0 text-xl font-semibold" {...props} />
					),
					h2: ({ node: _node, ...props }) => (
						<h2 className="mt-4 first:mt-0 text-lg font-semibold" {...props} />
					),
					h3: ({ node: _node, ...props }) => (
						<h3 className="mt-3 first:mt-0 text-base font-semibold" {...props} />
					),
					p: ({ node: _node, ...props }) => (
						<p className="mt-3 first:mt-0 whitespace-pre-wrap" {...props} />
					),
					a: ({ node: _node, ...props }) => (
						<a
							className="text-primary underline underline-offset-2 hover:text-primary/80"
							target="_blank"
							rel="noreferrer"
							{...props}
						/>
					),
					ul: ({ node: _node, ...props }) => <ul className="mt-3 list-disc pl-5" {...props} />,
					ol: ({ node: _node, ...props }) => <ol className="mt-3 list-decimal pl-5" {...props} />,
					li: ({ node: _node, ...props }) => <li className="mt-1" {...props} />,
					blockquote: ({ node: _node, ...props }) => (
						<blockquote
							className="mt-3 border-l-2 border-border pl-4 italic text-muted-foreground"
							{...props}
						/>
					),
					hr: ({ node: _node, ...props }) => <hr className="my-4 border-border" {...props} />,
					code: ({ node: _node, className, children, ...props }) => {
						const inline = !className;
						if (inline) {
							return (
								<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]" {...props}>
									{children}
								</code>
							);
						}
						return (
							<code className={cn("font-mono text-xs", className)} {...props}>
								{children}
							</code>
						);
					},
					pre: ({ node: _node, ...props }) => (
						<pre
							className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted/50 p-3"
							{...props}
						/>
					),
					table: ({ node: _node, ...props }) => (
						<div className="mt-3 overflow-x-auto">
							<table className="min-w-full border-collapse text-left text-xs" {...props} />
						</div>
					),
					th: ({ node: _node, ...props }) => (
						<th className="border border-border bg-muted/50 px-2 py-1 font-medium" {...props} />
					),
					td: ({ node: _node, ...props }) => (
						<td className="border border-border px-2 py-1 align-top" {...props} />
					),
				}}
			>
				{content}
			</ReactMarkdown>
		</div>
	);
}
