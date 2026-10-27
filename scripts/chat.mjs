#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const defaultWorkerUrl = "https://hello-ai.imminent-hearing.workers.dev";
const url = (process.argv[2] ?? process.env.WORKER_URL ?? defaultWorkerUrl).replace(/\/$/, "");
const workerHostname = new URL(url).hostname;
const isLocalWorker = workerHostname === "localhost" || workerHostname === "127.0.0.1";
const maxSessionTokens = 2000;
const messages = [];
let sessionTokens = 0;
let localWorker;

async function workerIsReady() {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function ensureLocalWorker() {
	if (!isLocalWorker || (await workerIsReady())) return;

	const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
	const wrangler = resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js");
	try {
		await access(wrangler);
	} catch {
		throw new Error("Wrangler is not installed. Run npm install before starting the chat.");
	}

	localWorker = spawn(process.execPath, [wrangler, "dev"], {
		cwd: projectRoot,
		stdio: ["ignore", "ignore", "inherit"],
	});

	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (await workerIsReady()) return;
		if (localWorker.exitCode !== null) {
			throw new Error(`Local Worker exited before it was ready (code ${localWorker.exitCode}).`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Timed out waiting for the local Worker to start.");
}

function stopLocalWorker() {
	if (localWorker && localWorker.exitCode === null) localWorker.kill("SIGTERM");
}

function startThinkingAnimation() {
	const frames = ["   ", ".  ", ".. ", "..."];
	let frame = 0;
	let stopped = false;
	process.stdout.write("Thinking");
	const timer = setInterval(() => {
		process.stdout.write(`\rThinking${frames[frame]}`);
		frame = (frame + 1) % frames.length;
	}, 350);
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		process.stdout.write("\r         \r");
	};
}

function formatResponseError(response, body) {
	if (body.includes("Just a moment") || body.includes("challenge-platform")) {
		return `Request blocked by Cloudflare security challenge (HTTP ${response.status}). Try the deployed URL again in a browser first, or use a claimed account.`;
	}
	return `Request failed (${response.status}): ${body.slice(0, 500)}`;
}

const rl = readline.createInterface({ input, output });
let stopThinkingAnimation = () => {};

try {
	await ensureLocalWorker();
	console.log(`Chatting with ${url}/chat (session limit: ${maxSessionTokens} tokens).`);
	console.log("Type /exit to quit.\n");

	while (true) {
		let prompt;
		try {
			prompt = (await rl.question("> ")).trim();
		} catch (error) {
			if (error?.code === "ERR_USE_AFTER_CLOSE") break;
			throw error;
		}
		if (prompt === "/exit") break;
		if (prompt === "/newchat") {
			messages.length = 0;
			sessionTokens = 0;
			console.log("\nStarted a new chat. Session token usage has been reset.\n");
			continue;
		}
		if (!prompt) continue;
		if (sessionTokens >= maxSessionTokens) {
			console.log(`\nSession limit reached: ${sessionTokens}/${maxSessionTokens} tokens.\n`);
			break;
		}

		messages.push({ role: "user", content: prompt });
		stopThinkingAnimation = startThinkingAnimation();
		const response = await fetch(`${url}/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages, sessionTokens }),
		});
		if (!response.ok) {
			stopThinkingAnimation();
			console.error(formatResponseError(response, await response.text()));
			messages.pop();
			continue;
		}
		if (!response.body) {
			stopThinkingAnimation();
			console.error("Request failed: the Worker returned an empty response stream.");
			messages.pop();
			continue;
		}

		const reader = response.body
			.pipeThrough(new TextDecoderStream())
			.getReader();
		let buffer = "";
		let assistantText = "";
		let usage;
		let streamError;
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += value;
			const events = buffer.split("\n\n");
			buffer = events.pop();
			for (const event of events) {
				const line = event.split("\n").find((entry) => entry.startsWith("data: "));
				if (!line) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;
				const payload = JSON.parse(data);
				if (payload.type === "text") {
					stopThinkingAnimation();
					process.stdout.write(payload.text);
					assistantText += payload.text;
				} else if (payload.type === "usage") {
					usage = payload;
				} else if (payload.type === "error") {
					streamError = payload.error || "The Worker returned an unknown stream error.";
				} else if (payload.type === "limit") {
					console.error(`\n[${payload.message}]`);
				}
			}
		}
		stopThinkingAnimation();
		if (streamError) {
			console.error(`\nChat request failed: ${streamError}`);
			messages.pop();
			continue;
		}
		if (!assistantText) {
			console.error(
				"\nNo visible answer was generated. Please retry the request.",
			);
			messages.pop();
			continue;
		}
		if (assistantText) messages.push({ role: "assistant", content: assistantText });
		if (usage) {
			sessionTokens = usage.sessionTokens;
			console.log(
				`\n[token usage: prompt ${usage.promptTokens} + context ${usage.contextTokens} = model input ${usage.inputTokens}; output ${usage.outputTokens}; session counted ${usage.totalTokens}/${usage.maxSessionTokens}]\n`,
			);
		}
	}
} catch (error) {
	console.error(`\nChat connection error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	stopThinkingAnimation();
	rl.close();
	stopLocalWorker();
}
