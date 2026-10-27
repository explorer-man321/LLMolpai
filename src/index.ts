import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const MAX_SESSION_TOKENS = 2000;
const REASONING_TOKEN_BUDGET = 4096;
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

type ChatMessage = {
	role: "user" | "assistant";
	content: string;
};

function estimateTokens(messages: ChatMessage[]): number {
	return Math.ceil(
		(messages.reduce((total, message) => total + message.content.length, SYSTEM_PROMPT.length) + 32) / 3,
	);
}

function estimateTextTokens(text: string): number {
	return Math.ceil((text.length + 32) / 3);
}

function getLastUserMessage(messages: ChatMessage[]): string {
	return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function jsonEvent(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

export interface Env {
	AI: Ai;
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "GET") {
			return Response.json({
				name: "hello-ai",
				model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
				maxSessionTokens: MAX_SESSION_TOKENS,
				usage: "POST /chat with { messages, sessionTokens }",
			});
		}

		if (request.method !== "POST" || new URL(request.url).pathname !== "/chat") {
			return new Response("Not found", { status: 404 });
		}

		let body: { messages?: unknown; sessionTokens?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
		}

		const messages = body.messages;
		if (
			!Array.isArray(messages) ||
			messages.length === 0 ||
			messages.some(
				(message) =>
					!message ||
					typeof message !== "object" ||
					!["user", "assistant"].includes((message as { role?: unknown }).role as string) ||
					typeof (message as { content?: unknown }).content !== "string",
			)
		) {
			return Response.json(
				{ error: "messages must be a non-empty array of user/assistant messages." },
				{ status: 400 },
			);
		}

		const sessionTokens =
			typeof body.sessionTokens === "number" && Number.isFinite(body.sessionTokens)
				? Math.max(0, Math.floor(body.sessionTokens))
				: 0;
		const inputMessages = messages as ChatMessage[];
		const estimatedInputTokens = estimateTokens(inputMessages);
		const estimatedPromptTokens = estimateTextTokens(getLastUserMessage(inputMessages));
		const remainingTokens = MAX_SESSION_TOKENS - sessionTokens - estimatedPromptTokens;
		if (remainingTokens <= 0) {
			return Response.json(
				{
					error: "The 2,000-token session limit has been reached.",
					sessionTokens,
					estimatedPromptTokens,
					contextTokens: Math.max(0, estimatedInputTokens - estimatedPromptTokens),
					maxSessionTokens: MAX_SESSION_TOKENS,
				},
				{ status: 400 },
			);
		}

		const workersAi = createWorkersAI({ binding: env.AI });
		const result = streamText({
			model: workersAi("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"),
			system: SYSTEM_PROMPT,
			temperature: 1,
			maxOutputTokens: remainingTokens + REASONING_TOKEN_BUDGET,
			messages: inputMessages,
		});

		const stream = new ReadableStream({
			async start(controller) {
				try {
					let streamError: string | undefined;
					let reasoning = false;
					let pendingText = "";
					let assistantText = "";
					let outputClipped = false;
					const emitVisibleText = (text: string) => {
						if (!text || outputClipped) return;
						const remainingCharacters = Math.max(0, remainingTokens * 3 - 32 - assistantText.length);
						const visibleText = text.slice(0, remainingCharacters);
						assistantText += visibleText;
						if (visibleText) {
							controller.enqueue(new TextEncoder().encode(jsonEvent({ type: "text", text: visibleText })));
						}
						if (visibleText.length < text.length || estimateTextTokens(assistantText) >= remainingTokens) {
							outputClipped = true;
						}
					};
					const consumeText = (text: string, flush = false) => {
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
									emitVisibleText(pendingText);
									pendingText = "";
								} else {
									const safeLength = Math.max(0, pendingText.length - "<think>".length + 1);
									emitVisibleText(pendingText.slice(0, safeLength));
									pendingText = pendingText.slice(safeLength);
								}
								return;
							}

							emitVisibleText(pendingText.slice(0, start));
							pendingText = pendingText.slice(start + "<think>".length);
							reasoning = true;
						}
					};
					for await (const event of result.fullStream) {
						if (event.type === "text-delta") {
							consumeText(event.text);
						} else if (event.type === "error") {
							streamError = event.error instanceof Error ? event.error.message : String(event.error);
						}
					}
					if (!reasoning) consumeText("", true);
					if (streamError) {
						controller.enqueue(new TextEncoder().encode(jsonEvent({ type: "error", error: streamError })));
						controller.close();
						return;
					}
					if (!assistantText.trim()) {
						controller.enqueue(
							new TextEncoder().encode(
								jsonEvent({
									type: "error",
									error: "The model returned no visible answer after filtering internal reasoning.",
								}),
							),
						);
						controller.close();
						return;
					}
					const usage = await result.usage;
					const inputTokens = usage.inputTokens ?? estimatedInputTokens;
					const promptTokens = estimatedPromptTokens;
					const outputTokens = estimateTextTokens(assistantText);
					const totalTokens = promptTokens + outputTokens;
					controller.enqueue(
						new TextEncoder().encode(
							jsonEvent({
								type: "usage",
								inputTokens,
								promptTokens,
								contextTokens: Math.max(0, inputTokens - promptTokens),
								outputTokens,
								totalTokens,
								sessionTokens: sessionTokens + totalTokens,
								maxSessionTokens: MAX_SESSION_TOKENS,
							}),
						),
					);
					if (outputClipped || outputTokens >= remainingTokens) {
						controller.enqueue(
							new TextEncoder().encode(
								jsonEvent({
									type: "limit",
									message: "Output clipped: the visible session token limit was reached.",
									visibleTokenLimit: remainingTokens,
								}),
							),
						);
					}
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
					controller.close();
				} catch (error) {
					controller.enqueue(
						new TextEncoder().encode(
							jsonEvent({ type: "error", error: error instanceof Error ? error.message : "AI request failed." }),
						),
					);
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
			},
		});
	},
} satisfies ExportedHandler<Env>;
