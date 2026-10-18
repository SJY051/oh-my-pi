import type { ContentAnnotations, ContentAudience } from "../types";

type Annotated = { type: string; annotations?: ContentAnnotations };

function isAddressedTo(block: { type: string }, audience: ContentAudience): boolean {
	const named = (block as Annotated).annotations?.audience;
	return named === undefined || named.length === 0 || named.includes(audience);
}

/**
 * The blocks of a tool result's `content` that the transcript may draw: every
 * block except those annotated for the model alone (`audience: ["assistant"]`).
 * Returns `content` itself when nothing is dropped.
 */
export function contentForUser<T extends { type: string }>(content: T[]): T[] {
	return content.every(block => isAddressedTo(block, "user"))
		? content
		: content.filter(block => isAddressedTo(block, "user"));
}

/**
 * The blocks of a tool result's `content` the model receives: every block
 * except those annotated for the user alone (`audience: ["user"]`), with the
 * `annotations` field removed so no provider ever sees it. Returns `content`
 * itself when it needs neither.
 */
export function contentForModel<T extends { type: string }>(content: T[]): T[] {
	if (!content.some(block => (block as Annotated).annotations !== undefined)) return content;
	const out: T[] = [];
	for (const block of content) {
		if (!isAddressedTo(block, "assistant")) continue;
		const { annotations: _annotations, ...rest } = block as Annotated & T;
		out.push(rest as unknown as T);
	}
	return out;
}
