import { describe, expect, it } from "bun:test";
import type { ImageContent, TextContent } from "../src/types";
import { contentForModel, contentForUser } from "../src/utils/content-audience";

type Audience = ("user" | "assistant")[];

const text = (value: string, audience?: Audience): TextContent => ({
	type: "text",
	text: value,
	...(audience ? { annotations: { audience } } : {}),
});
const image = (audience?: Audience): ImageContent => ({
	type: "image",
	data: "AAAA",
	mimeType: "image/png",
	...(audience ? { annotations: { audience } } : {}),
});

describe("content audience", () => {
	it("keeps the model's blocks out of what the transcript draws", () => {
		const content = [
			text("for all"),
			image(["assistant"]),
			text("for me", ["user"]),
			text("both", ["user", "assistant"]),
		];
		expect(contentForUser(content)).toEqual([content[0], content[2], content[3]]);
	});

	it("reads no audience, or an empty one, as everyone", () => {
		const content = [text("a"), image(), text("b", [])];
		expect(contentForUser(content)).toBe(content);
		expect(contentForModel([text("a"), image()])).toHaveLength(2);
		expect(contentForModel(content)).toEqual([text("a"), image(), text("b")]);
	});

	it("returns the same array when there is nothing to drop or strip", () => {
		const content = [text("a"), image()];
		expect(contentForUser(content)).toBe(content);
		expect(contentForModel(content)).toBe(content);
	});

	it("keeps the user's blocks away from the model and strips the annotation from what it receives", () => {
		const content = [
			text("for all"),
			image(["user"]),
			text("for you", ["assistant"]),
			text("both", ["user", "assistant"]),
		];
		expect(contentForModel(content)).toEqual([text("for all"), text("for you"), text("both")]);
		for (const block of contentForModel(content)) expect(block).not.toHaveProperty("annotations");
		// The original blocks keep theirs: the transcript still needs them.
		expect(content[2]).toHaveProperty("annotations");
	});
});
