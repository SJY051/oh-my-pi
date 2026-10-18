import { describe, expect, test } from "bun:test";
import type { ToolNativeEvent } from "@oh-my-pi/pi-tui/tools/renderer";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionContext } from "../src/extensibility/extensions/types";
import { wrapRegisteredTools } from "../src/extensibility/extensions/wrapper";
import { EventBus } from "../src/utils/event-bus";

const okResult = { content: [{ type: "text" as const, text: "ok" }] };

const click: ToolNativeEvent = {
	type: "action",
	toolCallId: "call-1",
	key: "form/send",
	act: "send",
	mods: [],
	values: { size: "m" },
	args: {},
	result: undefined,
};

async function wrapTools(register: (pi: Parameters<Parameters<typeof loadExtensionFromFactory>[0]>[0]) => void) {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(register, "/project", new EventBus(), runtime, "test-extension");
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		"/project",
		{ getCwd: () => "/project" } as never,
		{} as never,
	);
	return wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
}

describe("extension tool onNativeEvent", () => {
	test("a click in a tool's card reaches its hook with the extension context", async () => {
		const calls: { event: ToolNativeEvent; ctx: ExtensionContext }[] = [];
		const [tool] = await wrapTools(pi => {
			pi.registerTool({
				name: "card",
				label: "Card",
				description: "interactive card",
				parameters: pi.arktype({}),
				execute: async () => okResult,
				onNativeEvent: (event, ctx) => {
					calls.push({ event, ctx });
				},
			});
		});
		const hook = (tool as { onNativeEvent?: (event: ToolNativeEvent) => unknown }).onNativeEvent;
		if (!hook) throw new Error("onNativeEvent missing on the wrapped tool");

		await hook(click);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.event).toBe(click);
		// The context is the extension's own, so the handler can reach the session (pi.sendMessage lives in its closure).
		expect(calls[0]?.ctx.cwd).toBe("/project");
	});

	test("a tool without the hook stays without it, so its card knows to ignore events", async () => {
		const [tool] = await wrapTools(pi => {
			pi.registerTool({
				name: "plain",
				label: "Plain",
				description: "no interactive card",
				parameters: pi.arktype({}),
				execute: async () => okResult,
			});
		});
		expect((tool as { onNativeEvent?: unknown }).onNativeEvent).toBeUndefined();
	});
});
