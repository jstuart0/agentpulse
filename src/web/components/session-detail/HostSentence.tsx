import { type SentencePart, sentenceParts } from "./session-takeover-view.js";

/** A sentence the host or the server wrote, with its `backtick` spans drawn as code. Every part is a text node. */
export function HostSentence({ text }: { text: string }) {
	const parts: SentencePart[] = sentenceParts(text);
	return (
		<>
			{parts.map((part, index) =>
				part.code ? (
					<code
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one string
						key={index}
						className="break-normal rounded bg-muted px-1 font-mono text-[0.95em] text-foreground"
					>
						{part.text}
					</code>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one string
					<span key={index}>{part.text}</span>
				),
			)}
		</>
	);
}
