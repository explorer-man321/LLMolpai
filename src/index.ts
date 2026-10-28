import { DurableObject } from "cloudflare:workers";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const MAX_SESSION_TOKENS = 2000;
const REASONING_TOKEN_BUDGET = 1024;
const MODEL = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
const SYSTEM_PROMPT = `You are an offline AI engineering assistant serving contestants in the competitive AI Olympiad (OLP AI) environment, running on local hardware.

Language & Communication:
1. Always respond in fluent, concise, technical Vietnamese, regardless of prompt language, unless explicitly instructed otherwise.
2. Keep technical terms, libraries, layer names, metrics, and standard machine learning terminology in English (e.g., PyTorch, DataLoader, cross-entropy, backpropagation, open-set recognition, LoRA, macro-F1).
3. Do not include social pleasantries, greetings, apologies, or generic concluding remarks. Maintain a neutral, precise, contest-focused tone.

Operational Mode & Role in Competition:
1. Role: Act as a senior AI/ML researcher and competitive machine learning advisor.
2. Focus Areas: Brainstorming model architectures, diagnosing loss convergence issues, structuring data pipelines, feature engineering, loss function design, and debugging code tracebacks (PyTorch, OpenCV, Scikit-learn, NumPy).
3. Code Quality:
   - Provide clean, production-ready, vectorized Python/PyTorch code.
   - Avoid placeholder functions unless strictly necessary.
   - Prioritize memory-efficient implementations (e.g., torch.no_grad(), gradient accumulation, mixed precision with torch.amp) suitable for limited GPU environments.
4. Problem Breakdown:
   - For mathematical, algorithmic, or pipeline queries, proceed logically: define the objective formulation, specify the algorithmic pipeline, highlight potential bottlenecks/pitfalls (e.g., data leakage, CUDA OOM), and deliver the core implementation.
5. Always finish with a visible answer after any internal reasoning. Do not return only internal reasoning or an empty response.`;

type ChatMessage = { role: "user" | "assistant"; content: string };
type SessionState = { messages: ChatMessage[]; sessionTokens: number };

function estimateTokens(messages: ChatMessage[]): number {
	return Math.ceil(
		(messages.reduce((total, message) => total + message.content.length, SYSTEM_PROMPT.length) + 32) / 3,
	);
}

function estimateTextTokens(text: string): number {
	return Math.ceil((text.length + 32) / 3);
}

function jsonEvent(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function createVisibleTextFilter(remainingTokens: number, controller: ReadableStreamDefaultController<Uint8Array>) {
	let reasoning = false;
	let pendingText = "";
	let assistantText = "";
	let outputClipped = false;
	const encoder = new TextEncoder();
	const emit = (text: string) => {
		if (!text || outputClipped) return;
		const remainingCharacters = Math.max(0, remainingTokens * 3 - 32 - assistantText.length);
		const visibleText = text.slice(0, remainingCharacters);
		assistantText += visibleText;
		if (visibleText) controller.enqueue(encoder.encode(jsonEvent({ type: "text", text: visibleText })));
		if (visibleText.length < text.length || estimateTextTokens(assistantText) >= remainingTokens) {
			outputClipped = true;
		}
	};
	const consume = (text: string, flush = false) => {
		pendingText += text;
		while (pendingText) {
			if (reasoning) {
				const end = pendingText.indexOf("</think>");
				if (end === -1) {
					pendingText = "";
					return;
				}
				pendingText = pendingText.slice(end + "</think>".length);
				reasoning = false;
				continue;
			}
			const start = pendingText.indexOf("<think>");
			if (start === -1) {
				if (flush) {
					emit(pendingText);
					pendingText = "";
				} else {
					const safeLength = Math.max(0, pendingText.length - "<think>".length + 1);
					emit(pendingText.slice(0, safeLength));
					pendingText = pendingText.slice(safeLength);
				}
				return;
			}
			emit(pendingText.slice(0, start));
			pendingText = pendingText.slice(start + "<think>".length);
			reasoning = true;
		}
	};
	return {
		consume,
		finish: () => { if (!reasoning) consume("", true); },
		get assistantText() { return assistantText; },
		get outputClipped() { return outputClipped; },
	};
}

export interface Env {
	AI: Ai;
	CHAT_SESSIONS: DurableObjectNamespace<ChatSession>;
}

export class ChatSession extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		let body: { message?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
		}
		if (typeof body.message !== "string" || !body.message.trim()) {
			return Response.json({ error: "message must be a non-empty string." }, { status: 400 });
		}

		const state = (await this.ctx.storage.get<SessionState>("state")) ?? {
			messages: [],
			sessionTokens: 0,
		};
		const estimatedPromptTokens = estimateTextTokens(body.message);
		const estimatedInputTokens = estimateTokens(state.messages.concat({ role: "user", content: body.message }));
		const remainingTokens = MAX_SESSION_TOKENS - state.sessionTokens - estimatedPromptTokens;
		if (remainingTokens <= 0) {
			return Response.json(
				{ error: "The 2,000-token session limit has been reached.", sessionTokens: state.sessionTokens, estimatedPromptTokens, contextTokens: Math.max(0, estimatedInputTokens - estimatedPromptTokens), maxSessionTokens: MAX_SESSION_TOKENS },
				{ status: 400 },
			);
		}

		const messages = [...state.messages, { role: "user" as const, content: body.message }];
		const result = streamText({
			model: createWorkersAI({ binding: this.env.AI })(MODEL),
			system: SYSTEM_PROMPT,
			temperature: 0.2,
			topP: 0.9,
			maxOutputTokens: remainingTokens + REASONING_TOKEN_BUDGET,
			messages,
		});
		const storage = this.ctx.storage;
		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				try {
					let streamError: string | undefined;
					const visible = createVisibleTextFilter(remainingTokens, controller);
					for await (const event of result.fullStream) {
						if (event.type === "text-delta") visible.consume(event.text);
						else if (event.type === "error") streamError = event.error instanceof Error ? event.error.message : String(event.error);
						if (visible.outputClipped) break;
					}
					visible.finish();
					if (streamError) {
						controller.enqueue(encoder.encode(jsonEvent({ type: "error", error: streamError })));
						controller.close();
						return;
					}
					if (!visible.assistantText.trim()) {
						controller.enqueue(encoder.encode(jsonEvent({ type: "error", error: "The model returned no visible answer after filtering internal reasoning." })));
						controller.close();
						return;
					}
					const outputTokens = estimateTextTokens(visible.assistantText);
					const totalTokens = estimatedPromptTokens + outputTokens;
					const nextState: SessionState = {
						messages: [...messages, { role: "assistant", content: visible.assistantText }],
						sessionTokens: state.sessionTokens + totalTokens,
					};
					await storage.put("state", nextState);
					if (visible.outputClipped) {
						controller.enqueue(encoder.encode(jsonEvent({
							type: "usage",
							inputTokens: estimatedInputTokens,
							promptTokens: estimatedPromptTokens,
							contextTokens: Math.max(0, estimatedInputTokens - estimatedPromptTokens),
							outputTokens,
							totalTokens,
							sessionTokens: nextState.sessionTokens,
							maxSessionTokens: MAX_SESSION_TOKENS,
						})));
						controller.enqueue(encoder.encode(jsonEvent({ type: "limit", message: "Output clipped: the visible session token limit was reached.", visibleTokenLimit: remainingTokens })));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(jsonEvent({
						type: "usage",
						inputTokens: (await result.usage).inputTokens ?? estimatedInputTokens,
						promptTokens: estimatedPromptTokens,
						contextTokens: Math.max(0, estimatedInputTokens - estimatedPromptTokens),
						outputTokens,
						totalTokens,
						sessionTokens: nextState.sessionTokens,
						maxSessionTokens: MAX_SESSION_TOKENS,
					})));
					if (visible.outputClipped || outputTokens >= remainingTokens) {
						controller.enqueue(encoder.encode(jsonEvent({ type: "limit", message: "Output clipped: the visible session token limit was reached.", visibleTokenLimit: remainingTokens })));
					}
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				} catch (error) {
					controller.enqueue(encoder.encode(jsonEvent({ type: "error", error: error instanceof Error ? error.message : "AI request failed." })));
					controller.close();
				}
			},
		});
		return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET") return Response.json({ name: "hello-ai", model: MODEL, maxSessionTokens: MAX_SESSION_TOKENS, usage: "POST /chat with { sessionId, message }" });
		if (request.method !== "POST" || url.pathname !== "/chat") return new Response("Not found", { status: 404 });
		let body: { sessionId?: unknown; message?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
		}
		if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return Response.json({ error: "sessionId must be a non-empty string." }, { status: 400 });
		const stub = env.CHAT_SESSIONS.getByName(body.sessionId);
		return stub.fetch(new Request("https://chat-session/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: body.message }) }));
	},
} satisfies ExportedHandler<Env>;
