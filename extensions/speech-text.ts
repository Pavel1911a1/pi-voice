/**
 * Turns an assistant reply (Markdown) into something worth listening to: no code, tables, paths
 * or links, split into sentences tagged with the language to read them in.
 */

export type SpeechLanguage = "ru" | "en";

export interface SpeechSegment {
	text: string;
	lang: SpeechLanguage;
}

const TAIL: Record<SpeechLanguage, string> = {
	ru: "Остальное на экране.",
	en: "The rest is on screen.",
};

// Keeps the first audio short so speech starts quickly; later segments may be longer.
const SEGMENT_CHARS = 300;

const FILE_EXTENSIONS =
	"ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|py|java|kt|go|rs|rb|php|cs|c|h|cpp|hpp|sh|zsh|ps1|yml|yaml|toml|ini|xml|html|css|txt|log|sql|csv|wav|bin|lock|gradle|properties|cbl|cob|cpy|jcl|pli";
const FILE_NAME = new RegExp(`^[\\w.-]*[\\w-]\\.(${FILE_EXTENSIONS})(:\\d+(-\\d+)?)?$`, "i");

function looksLikePath(token: string): boolean {
	const bare = token.replace(/^[("'«]+|[)"'».,;!?]+$/g, "");
	if (/^(https?|file|ssh|git):/i.test(bare)) return true;
	if (/^(~|\.{1,2})?[\\/]./.test(bare)) return true;
	if (/^[A-Za-z]:\\/.test(bare)) return true;
	if ((bare.match(/[\\/]/g) ?? []).length >= 2) return true;
	return FILE_NAME.test(bare) || /^[\w.-]+\/[\w.-]+\.\w+/.test(bare);
}

function cleanMarkdown(markdown: string): string {
	return (
		markdown
			// Code blocks and tables are unreadable aloud.
			.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, "")
			.replace(/^\s*\|.*$/gm, "")
			.replace(/<[^>]+>/g, "")
			// Images, then links: keep the link text.
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// Inline code: keep short names, drop paths and long snippets.
			.replace(/`([^`\n]+)`/g, (_m, code: string) => (looksLikePath(code) || code.length > 40 ? "" : code))
			// Markdown markers.
			.replace(/^\s{0,3}#{1,6}\s+/gm, "")
			.replace(/^\s*>\s?/gm, "")
			.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
			.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
			.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
			.replace(/^\s*([-*_]\s*){3,}$/gm, "")
	);
}

function speakableLine(line: string): string {
	const words = line
		.split(/\s+/)
		.filter((word) => word && !looksLikePath(word))
		.join(" ")
		.replace(/[\\/]/g, " ")
		.replace(/[→⇒]/g, ",")
		.replace(/[—–]/g, ",")
		.replace(/[^\p{L}\p{N}\s.,;:!?%+'"«»()-]/gu, "")
		.replace(/\(\s*\)/g, "")
		.replace(/\s+([.,;:!?])/g, "$1")
		.replace(/([,;:])(?:\s*[,;:])+/g, "$1")
		.replace(/\.{2,}/g, ".")
		.replace(/\s+/g, " ")
		.trim();
	if (!/\p{L}/u.test(words)) return "";
	// A trailing colon introduced something removed above (code, a table): end the sentence there.
	if (words.endsWith(":")) return `${words.slice(0, -1)}.`;
	// Lines of a list have no final punctuation; add it so the voice pauses between them.
	return /[.!?…:]$/.test(words) ? words : `${words}.`;
}

export function detectLanguage(text: string): SpeechLanguage {
	const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
	const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
	// Russian sentences are full of English terms; a little Cyrillic is enough to read in Russian.
	return cyrillic > 0 && cyrillic >= latin * 0.3 ? "ru" : "en";
}

export function toSpeech(markdown: string, maxChars: number): SpeechSegment[] {
	const sentences = cleanMarkdown(markdown)
		.split("\n")
		.map(speakableLine)
		.filter(Boolean)
		.join(" ")
		.split(/(?<=[.!?…])\s+/)
		.filter((s) => /\p{L}/u.test(s));

	const kept: string[] = [];
	let total = 0;
	let truncated = false;
	for (const sentence of sentences) {
		if (kept.length && total + sentence.length > maxChars) {
			truncated = true;
			break;
		}
		kept.push(sentence);
		total += sentence.length + 1;
	}
	if (!kept.length) return [];

	const segments: SpeechSegment[] = [];
	for (const sentence of kept) {
		const lang = detectLanguage(sentence);
		const last = segments.at(-1);
		const limit = segments.length === 1 ? SEGMENT_CHARS / 2 : SEGMENT_CHARS;
		if (last && last.lang === lang && last.text.length + sentence.length < limit) last.text += ` ${sentence}`;
		else segments.push({ text: sentence, lang });
	}
	if (truncated) {
		const lang = detectLanguage(kept.join(" "));
		segments.push({ text: TAIL[lang], lang });
	}
	return segments;
}
