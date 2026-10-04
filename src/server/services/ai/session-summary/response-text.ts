/** AGEN-69: stub, replaced in the fix commit. */
export interface ReadResponse {
	text: string;
	exitCode: number | null;
}
export function readResponse(_stored: string | null | undefined): ReadResponse {
	return { text: "", exitCode: null };
}
