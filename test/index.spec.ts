import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Hello AI worker", () => {
	it("returns health information (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.json()).toMatchObject({
			name: "hello-ai",
			maxSessionTokens: 2000,
		});
	});

	it("returns health information (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.json()).toMatchObject({
			name: "hello-ai",
			maxSessionTokens: 2000,
		});
	});
});
