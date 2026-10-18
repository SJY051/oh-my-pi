import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertMessageToLlm } from "../src/compaction/messages";

const result = (content: ToolResultMessage["content"]): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "artifact",
	content,
	isError: false,
	timestamp: 1,
});

const image = (audience: ("user" | "assistant")[]) =>
	({ type: "image", data: "AAAA", mimeType: "image/png", annotations: { audience } }) as const;

describe("tool result content for the model", () => {
	it("sends the model a block meant for it, without the annotation that said so", () => {
		const converted = convertMessageToLlm(result([{ type: "text", text: "shown" }, image(["assistant"])]));
		expect(converted).toMatchObject({ role: "toolResult" });
		const content = (converted as ToolResultMessage).content;
		expect(content).toEqual([
			{ type: "text", text: "shown" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});

	it("keeps a block meant for the user away from the model", () => {
		const converted = convertMessageToLlm(result([{ type: "text", text: "kept" }, image(["user"])]));
		expect((converted as ToolResultMessage).content).toEqual([{ type: "text", text: "kept" }]);
	});

	it("never hands the provider an empty result when every block was for the user", () => {
		const converted = convertMessageToLlm(result([image(["user"])]));
		expect((converted as ToolResultMessage).content).toEqual([{ type: "text", text: "(no output)" }]);
	});

	it("leaves the stored message's content and annotations as they were", () => {
		const stored = result([image(["assistant"])]);
		convertMessageToLlm(stored);
		expect(stored.content).toEqual([image(["assistant"])]);
	});
});
