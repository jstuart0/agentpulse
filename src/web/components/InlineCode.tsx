import type { ReactNode } from "react";

/** The commands and variables the exclude copy names: shown in code, wherever the copy appears. */
const CODE_TOKENS = /(AGENTPULSE_SKIP=1|agentpulse exclude check)/;

/** Plain copy with its command names in code style. The copy stays one plain string everywhere else. */
export function InlineCode({ text }: { text: string }): ReactNode {
	return text.split(CODE_TOKENS).map((part, index) =>
		index % 2 === 1 ? (
			<code key={`${index}-${part}`} className="font-mono text-foreground">
				{part}
			</code>
		) : (
			part
		),
	);
}
