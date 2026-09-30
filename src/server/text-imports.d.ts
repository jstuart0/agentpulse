// Bun's text loader (`import x from "./f.sh" with { type: "text" }`).
declare module "*.sh" {
	const text: string;
	export default text;
}
declare module "*.ps1" {
	const text: string;
	export default text;
}
