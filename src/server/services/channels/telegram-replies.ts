/** Fixed replies the Telegram Ask handler sends. No interpolation: nothing about the message, the chat or an error goes in. */
export const ASK_TOO_LONG_REPLY =
	"That message is too long for me to answer (the limit is 8,000 characters). Please shorten it and send it again.";

/** Sent when the chat's message waited out the turn limiter and no slot came free. */
export const ASK_BUSY_REPLY =
	"I'm answering other questions right now. Please send that again in a minute.";
