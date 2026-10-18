import { describe, expect, test } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionFactory } from "../src/extensibility/extensions/types";
import { EventBus } from "../src/utils/event-bus";

const okResult = { content: [{ type: "text" as const, text: "ok" }] };

function registerCard(pi: ExtensionAPI, name: string): void {
	pi.registerTool({
		name,
		label: name,
		description: "interactive card",
		parameters: pi.arktype({}),
		execute: async () => okResult,
	});
}

async function load(factories: Record<string, ExtensionFactory>, runtime: ExtensionRuntime) {
	const bus = new EventBus();
	return Promise.all(
		Object.entries(factories).map(([name, factory]) =>
			loadExtensionFromFactory(factory, "/project", bus, runtime, name),
		),
	);
}

describe("pi.redescribeToolCards", () => {
	test("reaches the host for the extension's own tool, with the call it names", async () => {
		const runtime = new ExtensionRuntime();
		let api: ExtensionAPI | undefined;
		const extensions = await load(
			{
				mine: pi => {
					api = pi;
					registerCard(pi, "card");
				},
			},
			runtime,
		);
		const asked: [string, string | undefined][] = [];
		const runner = new ExtensionRunner(
			extensions,
			runtime,
			"/project",
			{ getCwd: () => "/project" } as never,
			{} as never,
		);
		runner.initialize(
			{ redescribeToolCards: (name: string, id?: string) => asked.push([name, id]) } as never,
			{} as never,
		);

		api!.redescribeToolCards("card");
		api!.redescribeToolCards("card", "call-7");
		expect(asked).toEqual([
			["card", undefined],
			["card", "call-7"],
		]);
	});

	test("ignores a tool another extension owns, or none", async () => {
		const runtime = new ExtensionRuntime();
		let api: ExtensionAPI | undefined;
		const extensions = await load(
			{
				mine: pi => {
					api = pi;
					registerCard(pi, "card");
				},
				theirs: pi => registerCard(pi, "their-card"),
			},
			runtime,
		);
		const asked: string[] = [];
		const runner = new ExtensionRunner(
			extensions,
			runtime,
			"/project",
			{ getCwd: () => "/project" } as never,
			{} as never,
		);
		runner.initialize({ redescribeToolCards: (name: string) => asked.push(name) } as never, {} as never);

		api!.redescribeToolCards("their-card");
		api!.redescribeToolCards("no-such-tool");
		expect(asked).toEqual([]);
	});

	test("is a no-op before the host initializes the runtime and in a mode with no transcript", async () => {
		const runtime = new ExtensionRuntime();
		let api: ExtensionAPI | undefined;
		const extensions = await load(
			{
				mine: pi => {
					api = pi;
					registerCard(pi, "card");
				},
			},
			runtime,
		);
		expect(() => api!.redescribeToolCards("card")).not.toThrow();

		const runner = new ExtensionRunner(
			extensions,
			runtime,
			"/project",
			{ getCwd: () => "/project" } as never,
			{} as never,
		);
		runner.initialize({} as never, {} as never);
		expect(() => api!.redescribeToolCards("card", "call-1")).not.toThrow();
	});
});
