#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js");
const configPath = resolve(projectRoot, "wrangler.jsonc");
const chatPath = resolve(projectRoot, "scripts/chat.mjs");
const [accountArgument, domainArgument] = process.argv.slice(2);

function normalizeWorkerUrl(value, workerName) {
	const inputValue = value.trim().replace(/\/+$/, "");
	if (!inputValue) throw new Error("Worker domain cannot be empty.");

	const candidate = inputValue.includes("://") ? inputValue : `https://${inputValue}`;
	const parsed = new URL(candidate);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Worker domain must be a URL, hostname, or workers.dev subdomain.");
	}

	let hostname = parsed.hostname;
	if (hostname.endsWith(".workers.dev") && !hostname.startsWith(`${workerName}.`)) {
		hostname = `${workerName}.${hostname}`;
	}

	return `https://${hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

function updateAccountId(config, accountId) {
	if (!/^[a-f0-9]{32}$/i.test(accountId)) {
		throw new Error("Cloudflare account ID must be a 32-character hexadecimal value.");
	}
	if (/"account_id"\s*:/.test(config)) {
		return config.replace(/("account_id"\s*:\s*")[^"]*(")/, `$1${accountId}$2`);
	}
	return config.replace(/("name"\s*:\s*"[^"]+",)/, `$1\n\t"account_id": "${accountId}",`);
}

function updateChatUrl(chat, workerUrl) {
	return chat.replace(
		/(const defaultWorkerUrl = )(["']).*?\2;/,
		`$1${JSON.stringify(workerUrl)};`,
	);
}

function runDeploy() {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [wranglerPath, "deploy"], {
			cwd: projectRoot,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`Deployment failed${signal ? ` (${signal})` : ` with exit code ${code}`}.`));
		});
	});
}

const rl = accountArgument && domainArgument ? null : readline.createInterface({ input, output });
function ask(prompt) {
	return new Promise((resolvePromise, reject) => {
		rl.question(prompt, resolvePromise);
		rl.once("close", () => reject(new Error("Input closed before setup was complete.")));
	});
}

try {
	const config = await readFile(configPath, "utf8");
	const chat = await readFile(chatPath, "utf8");
	const currentAccount = config.match(/"account_id"\s*:\s*"([^"]+)"/)?.[1] ?? "";
	const currentUrl = chat.match(/const defaultWorkerUrl = ["']([^"']+)["'];/)?.[1] ?? "";

	console.log("Hello AI setup");
	console.log("This updates the Wrangler account, Worker URL, and deploys the Worker.\n");
	const accountId =
		(accountArgument ?? (await ask(`Cloudflare account ID${currentAccount ? ` [${currentAccount}]` : ""}: `))).trim() ||
		currentAccount;
	const domain =
		(domainArgument ?? (await ask(`Worker domain or URL${currentUrl ? ` [${currentUrl}]` : ""}: `))).trim() ||
		currentUrl;
	const workerUrl = normalizeWorkerUrl(domain, "hello-ai");

	await writeFile(configPath, updateAccountId(config, accountId));
	await writeFile(chatPath, updateChatUrl(chat, workerUrl));
	console.log(`\nConfigured account: ${accountId}`);
	console.log(`Configured Worker URL: ${workerUrl}`);
	console.log("\nDeploying...\n");
	await runDeploy();
	console.log(`\nDone. Run "npm run chat" to connect to ${workerUrl}.`);
} catch (error) {
	console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	rl?.close();
}
