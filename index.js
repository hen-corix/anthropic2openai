const express = require("express");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");

// --- Configuration ---
// Environment variables will be reread inside startServer()
let OPENAI_BASE_URL;
let OPENAI_API_KEY;
let OPENAI_MODEL;
let MODEL_MAP = {};
let LOG_FILE;
let UPSTREAM_TIMEOUT_MS;
let DEBUG_SSE;
let DEBUG_REQUESTS;
readEnvironmentVariables()

const app = express();
app.use(express.json({limit: "50mb"}));

// ---------- helpers ----------

/** Extract plain text string from Anthropic message content (string or block array) */
function extractTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.filter(b => b.type === "text").map(b => b.text || "").join("\n");
    }
    return "";
}

/**
 * Append a conversation entry to the log file as a single JSON line.
 * Each entry contains only message roles/content and the assistant response — no metadata.
 */
function logMessages(requestBody, responseText) {
    if (!LOG_FILE) return;
    const messages = [];
    if (requestBody.system) {
        messages.push({role: "system", content: extractTextContent(requestBody.system)});
    }
    for (const m of requestBody.messages || []) {
        messages.push({role: m.role, content: extractTextContent(m.content)});
    }
    const entry = {ts: new Date().toISOString(), messages};
    if (responseText !== undefined) entry.response = responseText;
    fs.appendFile(LOG_FILE, JSON.stringify(entry) + "\n", err => {
        if (err) console.error("Failed to write message log:", err);
    });
}

function genId(prefix = "msg") {
    // Generate a 24‑character hex identifier (12 bytes → 24 hex chars)
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Map Anthropic stop_reason ← OpenAI finish_reason */
function mapFinishReason(reason) {
    switch (reason) {
        case "stop":
            return "end_turn";
        case "length":
            return "max_tokens";
        case "content_filter":
            return "end_turn";
        default:
            return "end_turn";
    }
}

/** Map Anthropic tool_choice → OpenAI tool_choice */
function mapToolChoice(toolChoice) {
    if (typeof toolChoice === "string") {
        // Some clients pass the Anthropic type directly as a bare string
        toolChoice = {type: toolChoice};
    }
    switch (toolChoice.type) {
        case "auto":
            return "auto";
        case "none":
            return "none";
        case "any":
            return "required";
        case "tool":
            return {type: "function", function: {name: toolChoice.name}};
        default:
            return "auto";
    }
}

// ---------- request conversion ----------

/**
 * Convert an Anthropic Messages API request body into an OpenAI
 * Chat Completions request body.
 */
function anthropicToOpenAI(body) {
    const messages = [];

    // Anthropic "system" field → OpenAI system message
    if (body.system) {
        if (typeof body.system === "string") {
            messages.push({role: "system", content: body.system});
        } else if (Array.isArray(body.system)) {
            // system can be an array of content blocks
            const text = body.system
                .map((b) => (typeof b === "string" ? b : b.text || ""))
                .join("\n");
            messages.push({role: "system", content: text});
        }
    }

    // Convert messages
    for (const msg of body.messages || []) {
        // Only "user" and "assistant" roles are expected from Anthropic API
        // System prompts are handled separately via body.system
        let role;
        if (msg.role === "assistant") {
            role = "assistant";
        } else if (msg.role === "user") {
            role = "user";
        } else {
            console.warn(`Unexpected role "${msg.role}" in message, treating as "user"`);
            role = "user";
        }
        let content;

        if (typeof msg.content === "string") {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            // Convert Anthropic content blocks → OpenAI content parts
            const parts = [];
            for (const block of msg.content) {
                if (block.type === "text") {
                    parts.push({type: "text", text: block.text});
                } else if (block.type === "image") {
                    // Anthropic image block → OpenAI image_url
                    const src = block.source;
                    if (src && src.type === "base64") {
                        parts.push({
                            type: "image_url",
                            image_url: {
                                url: `data:${src.media_type};base64,${src.data}`,
                            },
                        });
                    } else if (src && src.type === "url") {
                        parts.push({
                            type: "image_url",
                            image_url: {url: src.url},
                        });
                    }
                }
                // tool_use / tool_result blocks are handled below
                else if (block.type === "tool_use") {
                    // Will be handled as a separate assistant tool_calls message
                } else if (block.type === "tool_result") {
                    // Will be handled as a tool message
                }
            }
            // Check for tool_use blocks in assistant messages
            if (role === "assistant") {
                const toolUseBlocks = msg.content.filter(
                    (b) => b.type === "tool_use"
                );
                if (toolUseBlocks.length > 0) {
                    const textParts = parts.filter((p) => p.type === "text");
                    const textContent =
                        textParts.length === 1
                            ? textParts[0].text
                            : textParts.length > 1
                                ? textParts
                                : null;
                    messages.push({
                        role: "assistant",
                        content: textContent,
                        tool_calls: toolUseBlocks.map((tu) => ({
                            id: tu.id,
                            type: "function",
                            function: {
                                name: tu.name,
                                arguments: JSON.stringify(tu.input),
                            },
                        })),
                    });
                    continue; // skip the normal push below
                }
            }

            // Check for tool_result blocks in user messages
            if (role === "user") {
                const toolResults = msg.content.filter(
                    (b) => b.type === "tool_result"
                );
                if (toolResults.length > 0) {
                    // Push any text parts first as a user message
                    const textParts = parts.filter((p) => p.type === "text");
                    if (textParts.length > 0) {
                        messages.push({
                            role: "user",
                            content:
                                textParts.length === 1 ? textParts[0].text : textParts,
                        });
                    }
                    // Then push each tool result
                    for (const tr of toolResults) {
                        let resultContent;
                        if (typeof tr.content === "string") {
                            resultContent = tr.content;
                        } else if (Array.isArray(tr.content)) {
                            resultContent = tr.content
                                .map((b) => (typeof b === "string" ? b : b.text || ""))
                                .join("\n");
                        } else {
                            resultContent = "";
                        }
                        // OpenAI tool messages have no error flag; preserve the
                        // Anthropic is_error signal inline so it is not lost.
                        if (tr.is_error) {
                            resultContent = "[tool error] " + resultContent;
                        }
                        messages.push({
                            role: "tool",
                            tool_call_id: tr.tool_use_id,
                            content: resultContent,
                        });
                    }
                    continue;
                }
            }

            content =
                parts.length === 1 && parts[0].type === "text"
                    ? parts[0].text
                    : parts.length > 0
                        ? parts
                        : null;
        } else {
            content = null;
        }

        // Only push message if it has non-empty content
        if (content !== null && content !== "" && content !== undefined) {
            messages.push({role, content});
        }
    }

    // Determine which OpenAI model to use (allow mapping from Anthropic model name)
    let mappedModel = MODEL_MAP[body.model];
    const selectedModel = mappedModel || OPENAI_MODEL;

    const openaiReq = {
        model: selectedModel,
        messages,
        stream: !!body.stream,
    };

    if (body.max_tokens != null) openaiReq.max_tokens = body.max_tokens;
    if (body.temperature != null) openaiReq.temperature = body.temperature;
    if (body.top_p != null) openaiReq.top_p = body.top_p;
    if (body.top_k != null) {
        console.warn("top_k is not supported by the OpenAI Chat Completions API and will not be forwarded");
    }
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
        if (body.stop_sequences.length > 4) {
            console.warn(`stop_sequences has ${body.stop_sequences.length} items, truncating to 4 (OpenAI limit)`);
        }
        openaiReq.stop = body.stop_sequences.slice(0, 4);
    }

    // Tool definitions
    if (body.tools && body.tools.length > 0) {
        openaiReq.tools = body.tools.map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description || "",
                parameters: t.input_schema || {},
            },
        }));
        // tool_choice is only valid alongside tool definitions (OpenAI rejects it otherwise)
        if (body.tool_choice != null) {
            openaiReq.tool_choice = mapToolChoice(body.tool_choice);
        }
    }

    if (body.stream) {
        openaiReq.stream_options = {include_usage: true};
    }

    return openaiReq;
}

// ---------- response conversion (non-streaming) ----------

function openAIToAnthropic(openaiRes, requestModel) {
    const choice = openaiRes.choices?.[0];
    const msg = choice?.message || {};

    const content = [];

    if (msg.content) {
        content.push({type: "text", text: msg.content});
    }

    // Tool calls
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            let args;
            try {
                args = JSON.parse(tc.function.arguments);
            } catch {
                console.warn("Failed to parse tool call arguments, using empty object:", tc.function.arguments);
                args = {};
            }
            content.push({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: args,
            });
        }
    }

    const stopReason = msg.tool_calls
        ? "tool_use"
        : mapFinishReason(choice?.finish_reason);

    return {
        id: genId("msg"),
        type: "message",
        role: "assistant",
        content,
        model: requestModel || openaiRes.model || OPENAI_MODEL,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: openaiRes.usage?.prompt_tokens || 0,
            output_tokens: openaiRes.usage?.completion_tokens || 0,
        },
    };
}

// ---------- streaming conversion ----------

/**
 * Read an OpenAI SSE stream and re-emit Anthropic SSE events on `res`.
 */
async function streamOpenAIToAnthropic(openaiResponse, res, requestModel) {
    const msgId = genId("msg");

    let contentBlockStarted = false;
    let blockIndex = 0;
    let toolCallAccum = {}; // id -> { id, name, argsJson }
    let stopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    let messageStartSent = false;
    let responseText = "";

    const reader = openaiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    function sendMessageStart() {
        if (messageStartSent) return;
        messageStartSent = true;
        const messageStart = {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: requestModel || OPENAI_MODEL,
            stop_reason: null,
            stop_sequence: null,
            usage: {input_tokens: inputTokens, output_tokens: outputTokens},
        };
        sendSSE(res, "message_start", {type: "message_start", message: messageStart});
    }

    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;
                const data = trimmed.slice(6);
                if (data === "[DONE]") continue;

                let chunk;
                try {
                    chunk = JSON.parse(data);
                } catch {
                    continue;
                }

                const choice = chunk.choices?.[0];
                const delta = choice?.delta;

                // Capture usage from any chunk that has it
                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0;
                    outputTokens = chunk.usage.completion_tokens || 0;
                }

                // Send message_start on first relevant chunk if not already sent
                if (!messageStartSent && (delta || choice?.finish_reason)) {
                    sendMessageStart();
                }

                if (!delta && !choice?.finish_reason) continue;

                // --- Text content ---
                if (delta && delta.content) {
                    responseText += delta.content;
                    if (!contentBlockStarted) {
                        sendSSE(res, "content_block_start", {
                            type: "content_block_start",
                            index: blockIndex,
                            content_block: {type: "text", text: ""},
                        });
                        contentBlockStarted = true;
                    }
                    sendSSE(res, "content_block_delta", {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {type: "text_delta", text: delta.content},
                    });
                }

                // --- Tool calls ---
                if (delta && delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCallAccum[idx]) {
                            // Only start the block if we have the required id and name
                            if (tc.id && tc.function?.name) {
                                // Close text content block if open
                                if (contentBlockStarted) {
                                    sendSSE(res, "content_block_stop", {
                                        type: "content_block_stop",
                                        index: blockIndex,
                                    });
                                    blockIndex++;
                                    contentBlockStarted = false;
                                }

                                toolCallAccum[idx] = {
                                    id: tc.id,
                                    name: tc.function.name,
                                    argsJson: "",
                                    blockIndex: blockIndex,
                                };

                                sendSSE(res, "content_block_start", {
                                    type: "content_block_start",
                                    index: blockIndex,
                                    content_block: {
                                        type: "tool_use",
                                        id: tc.id,
                                        name: tc.function.name,
                                        input: {},
                                    },
                                });
                                blockIndex++;
                            }
                            // If we don't have complete info yet, accumulate partial data
                            else {
                                toolCallAccum[idx] = {
                                    id: tc.id || null,
                                    name: tc.function?.name || "",
                                    argsJson: tc.function?.arguments || "",
                                    blockIndex: null, // Will be set when block starts
                                };
                            }
                        } else {
                            // Update accumulated data
                            if (tc.id) toolCallAccum[idx].id = tc.id;
                            if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;

                            // If the block hasn't been started yet, but now we have complete info, start it
                            if (toolCallAccum[idx].blockIndex === null && toolCallAccum[idx].id && toolCallAccum[idx].name) {
                                // Close text content block if open
                                if (contentBlockStarted) {
                                    sendSSE(res, "content_block_stop", {
                                        type: "content_block_stop",
                                        index: blockIndex,
                                    });
                                    blockIndex++;
                                    contentBlockStarted = false;
                                }

                                toolCallAccum[idx].blockIndex = blockIndex;

                                sendSSE(res, "content_block_start", {
                                    type: "content_block_start",
                                    index: blockIndex,
                                    content_block: {
                                        type: "tool_use",
                                        id: toolCallAccum[idx].id,
                                        name: toolCallAccum[idx].name,
                                        input: {},
                                    },
                                });
                                // Flush any buffered arguments
                                const bufferedArgs = toolCallAccum[idx].argsJson;
                                if (bufferedArgs) {
                                    sendSSE(res, "content_block_delta", {
                                        type: "content_block_delta",
                                        index: blockIndex,
                                        delta: {
                                            type: "input_json_delta",
                                            partial_json: bufferedArgs,
                                        },
                                    });
                                }
                                blockIndex++;
                            }
                        }

                        if (tc.function?.arguments && toolCallAccum[idx].blockIndex !== null) {
                            toolCallAccum[idx].argsJson += tc.function.arguments;
                            sendSSE(res, "content_block_delta", {
                                type: "content_block_delta",
                                index: toolCallAccum[idx].blockIndex,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: tc.function.arguments,
                                },
                            });
                        }
                    }
                }

                if (choice?.finish_reason) {
                    if (Object.keys(toolCallAccum).length > 0) {
                        stopReason = "tool_use";
                    } else {
                        stopReason = mapFinishReason(choice.finish_reason);
                    }
                }
            }
        }
    } catch (err) {
        console.error("Stream reading error:", err);
        // Send error event to client before ending stream
        sendMessageStart();
        sendSSE(res, "error", {
            type: "error",
            error: {
                type: "upstream_error",
                message: "Stream interrupted: " + (err.message || "Unknown error"),
            },
        });
        res.end();
        return {inputTokens, outputTokens, responseText};
    }

    // Close any open content block
    if (contentBlockStarted) {
        sendSSE(res, "content_block_stop", {
            type: "content_block_stop",
            index: blockIndex,
        });
    }
    // Close tool call blocks (only those that were properly started)
    for (const tc of Object.values(toolCallAccum)) {
        if (tc.blockIndex !== null) {
            sendSSE(res, "content_block_stop", {
                type: "content_block_stop",
                index: tc.blockIndex,
            });
        }
    }

    // Ensure message_start was sent (edge case: empty stream)
    sendMessageStart();

    // message_delta with stop_reason and usage
    sendSSE(res, "message_delta", {
        type: "message_delta",
        delta: {stop_reason: stopReason, stop_sequence: null},
        usage: {input_tokens: inputTokens, output_tokens: outputTokens},
    });

    sendSSE(res, "message_stop", {type: "message_stop"});
    res.end();

    // Return usage info and accumulated text for logging
    return {inputTokens, outputTokens, responseText};
}

function sendSSE(res, event, data) {
    // console.debug is an alias for console.log in Node (NOT suppressed), so this
    // is opt-in to avoid writing full conversation content to stdout by default.
    if (DEBUG_SSE) console.debug(`[SSE] event: ${event}`, JSON.stringify(data));
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- main route ----------

app.post("/v1/messages", async (req, res) => {
    const startTime = Date.now();
    let timer = null;
    try {
        // Validate API key presence before doing any conversion or logging work
        if (!OPENAI_API_KEY) {
            console.error("A2O_OPENAI_API_KEY environment variable is required and cannot be empty");
            return res.status(401).json({
                type: "error",
                error: {
                    type: "authentication_error",
                    message: "API key missing",
                },
            });
        }

        const bodyLength = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
        if (DEBUG_REQUESTS) {
            // Opt-in: logs a preview of conversation content to stdout.
            const messagesContent = (Array.isArray(req.body.messages) ? req.body.messages : [])
                .filter(m => m && m.role === 'assistant').map(m => m.content || '').map(c => JSON.stringify(c) || '').join(' ').substring(0, 100);
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${bodyLength}b - content: "${messagesContent}"`);
        } else {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${bodyLength}b`);
        }

        const anthropicBody = req.body;
        const openaiBody = anthropicToOpenAI(anthropicBody);

        // Determine actual model being used
        const mappedModel = MODEL_MAP[anthropicBody.model];
        const actualModel = mappedModel || OPENAI_MODEL;

        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        };

        // Abort the upstream request if it does not respond within the timeout,
        // so a hanging backend cannot keep proxy connections open indefinitely.
        const controller = new AbortController();
        if (UPSTREAM_TIMEOUT_MS > 0) {
            timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        }

        const openaiRes = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(openaiBody),
            signal: controller.signal,
        });

        if (!openaiRes.ok) {
            const errText = await openaiRes.text();
            console.error(`OpenAI API error ${openaiRes.status}: ${errText}`);
            return res.status(openaiRes.status).json({
                type: "error",
                error: {
                    type: "upstream_error",
                    message: `Upstream error: ${errText}`,
                },
            });
        }

        if (anthropicBody.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            const usage = await streamOpenAIToAnthropic(openaiRes, res, anthropicBody.model);
            logMessages(anthropicBody, usage.responseText);
            const duration = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - streaming - ${duration}ms - model: ${actualModel}, tokens: ${usage.inputTokens}+${usage.outputTokens}`);
        } else {
            const openaiJson = await openaiRes.json();
            const anthropicRes = openAIToAnthropic(openaiJson, anthropicBody.model);
            const responseText = anthropicRes.content.filter(b => b.type === "text").map(b => b.text).join("\n");
            logMessages(anthropicBody, responseText);
            const duration = Date.now() - startTime;
            const promptTokens = openaiJson.usage?.prompt_tokens || 0;
            const completionTokens = openaiJson.usage?.completion_tokens || 0;
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${JSON.stringify(anthropicRes).length}b - ${duration}ms - model: ${actualModel}, tokens: ${promptTokens}+${completionTokens}`);
            res.json(anthropicRes);
        }
    } catch (err) {
        // Upstream aborted because it exceeded A2O_UPSTREAM_TIMEOUT_MS
        if (err.name === 'AbortError') {
            console.error("Upstream request aborted (timeout):", err.message);
            return res.status(504).json({
                type: "error",
                error: {
                    type: "upstream_error",
                    message: "Upstream request timed out.",
                },
            });
        }

        // Provide more specific error responses based on error type
        const isNetworkError = err.name === 'FetchError' ||
            (err instanceof TypeError && (
                err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                err.code === 'UND_ERR_SOCKET' ||
                err.code === 'ECONNREFUSED' ||
                err.code === 'ENOTFOUND' ||
                err.code === 'ETIMEDOUT' ||
                err.message?.includes('fetch') ||
                err.message?.includes('network')
            ));

        if (isNetworkError) {
            // Network or fetch-related error
            console.error("Network error while contacting OpenAI:", err);
            res.status(502).json({
                type: "error",
                error: {
                    type: "upstream_error",
                    message: "Failed to reach OpenAI API. Check network connectivity and API key.",
                },
            });
        } else if (err instanceof TypeError) {
            // Likely a programming error, not a network issue
            console.error("Unexpected TypeError (possible bug):", err);
            res.status(500).json({
                type: "error",
                error: {
                    type: "api_error",
                    message: "Internal proxy error.",
                },
            });
        } else if (err.name === 'SyntaxError') {
            // JSON parsing error from OpenAI response
            console.error("Response parsing error:", err);
            res.status(502).json({
                type: "error",
                error: {
                    type: "upstream_error",
                    message: "Invalid response from OpenAI API.",
                },
            });
        } else {
            // Generic server error — keep details server-side, don't leak to client
            console.error("Proxy error:", err);
            res.status(500).json({
                type: "error",
                error: {
                    type: "api_error",
                    message: "Internal proxy error.",
                },
            });
        }
    } finally {
        if (timer) clearTimeout(timer);
    }
});

// Health check
app.get("/health", (_req, res) => res.json({status: "ok"}));

// Malformed request body (e.g. invalid JSON, body too large) → Anthropic-shaped
// error instead of Express's default HTML response, so Anthropic clients can
// parse it. The 4-arg signature is what makes Express treat this as error middleware.
app.use((err, _req, res, _next) => {
    console.error("Malformed request body:", err.message);
    res.status(400).json({
        type: "error",
        error: {
            type: "invalid_request_error",
            message: "Invalid request body.",
        },
    });
});

// ---------- exports ----------

module.exports = {
    app,
    anthropicToOpenAI,
    openAIToAnthropic,
    startServer,
    readEnvironmentVariables,
};

function readEnvironmentVariables() {
    if (require.main === module) {
        require('dotenv').config({quiet: true, override: true});
    }

    // (Re)read environment variables each time the server starts/restarts
    LOG_FILE = process.env.A2O_LOG_FILE || null;
    // Upstream request timeout in ms (0 disables it); guards against a hanging
    // OpenAI-compatible backend keeping proxy connections open indefinitely.
    const rawTimeout = parseInt(process.env.A2O_UPSTREAM_TIMEOUT_MS, 10);
    UPSTREAM_TIMEOUT_MS = Number.isInteger(rawTimeout) && rawTimeout >= 0 ? rawTimeout : 600000;
    // Opt-in verbose logging (both write conversation content to stdout).
    DEBUG_SSE = !!process.env.A2O_DEBUG_SSE;
    DEBUG_REQUESTS = !!process.env.A2O_DEBUG_REQUESTS;
    OPENAI_BASE_URL = (
        process.env.A2O_OPENAI_BASE_URL || "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    OPENAI_MODEL = process.env.A2O_OPENAI_MODEL || "gpt-4o";
    // Parse optional model mapping
    MODEL_MAP = (() => {
        const raw = process.env.A2O_MODEL_MAP;
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null) {
                console.error("A2O_MODEL_MAP must be a JSON object");
                return {};
            }
            const valid = {};
            const invalid = [];
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof k === "string" && typeof v === "string" && v.trim() !== "") {
                    valid[k] = v;
                } else {
                    invalid.push([k, v]);
                }
            }
            if (invalid.length) {
                console.error("A2O_MODEL_MAP contains invalid entries, ignoring them:", invalid);
            }
            return valid;
        } catch (e) {
            console.error("Failed to parse A2O_MODEL_MAP JSON", e);
            return {};
        }
    })();

    // Initialize SSL if configuration is provided
    let sslOptions = null;
    const SSL_KEY_PATH = process.env.A2O_SSL_KEY_PATH || "";
    const SSL_CERT_PATH = process.env.A2O_SSL_CERT_PATH || "";

    if (SSL_KEY_PATH && SSL_CERT_PATH) {
        try {
            sslOptions = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH),
            };
        } catch (e) {
            console.error("Failed to load SSL key/cert", e);
        }
    }

    // Validate API key configuration
    OPENAI_API_KEY = (process.env.A2O_OPENAI_API_KEY || "").trim();
    if (!OPENAI_API_KEY) {
        console.error("A2O_OPENAI_API_KEY environment variable is required and cannot be empty");
        // Do not exit; downstream request handling will return a 500 error.
    }
    return sslOptions;
}

/**
 * Starts the proxy server.
 *
 * This function contains the logic that was previously guarded by
 * `if (require.main === module)`. It reads SSL configuration, validates the
 * OpenAI API key, creates either an HTTPS or HTTP server, logs the start‑up
 * messages, and returns the underlying `http.Server`/`https.Server` instance
 * so callers can shut it down (useful for in‑process tests).
 *
 * The function is exported for use in tests; when the file is executed
 * directly (`node index.js`) we simply call it.
 */
function startServer() {
    let sslOptions = readEnvironmentVariables();
    if (!sslOptions) {
        console.warn("SSL configuration missing or invalid – falling back to HTTP");
    }

    // Validate and parse port number
    const defaultPort = 3456;
    let port = defaultPort;
    const portEnv = process.env.A2O_PROXY_PORT;
    if (portEnv) {
        const parsed = parseInt(portEnv, 10);
        if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
            console.error(`Invalid A2O_PROXY_PORT "${portEnv}", must be a number between 1 and 65535. Using default ${defaultPort}.`);
        } else {
            port = parsed;
        }
    }

    // Bind to loopback by default so the proxy (which uses the server-side
    // OpenAI key for every request, without client auth) is not exposed to the
    // network. Set A2O_BIND_HOST=0.0.0.0 to deliberately listen on all interfaces.
    const bindHost = process.env.A2O_BIND_HOST || "127.0.0.1";
    const isLoopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
    const displayHost = isLoopback ? "localhost" : bindHost;

    let server;
    if (sslOptions) {
        server = https.createServer(sslOptions, app).listen(port, bindHost, () => {
            console.log(`anthropic2openai proxy listening on https://${displayHost}:${port}`);
        });
    } else {
        server = app.listen(port, bindHost, () => {
            console.log(`anthropic2openai proxy listening on http://${displayHost}:${port}`);
        });
    }
    console.log(`Forwarding to: ${OPENAI_BASE_URL}/chat/completions`);
    console.log(`Using model: ${OPENAI_MODEL}`);
    return server;
}

if (require.main === module) {
    // Start the server and set up a Ctrl+R listener to restart it
    let server = startServer();

    // Function to restart the server
    const restartServer = () => {
        console.log("\n[CTRL+R] Restarting server...");
        // Gracefully close the existing server before starting a new one
        server.close((err) => {
            if (err) {
                console.error('Error closing server:', err);
            }
            server = startServer();
        });
    };

    // Enable raw mode to capture key presses
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", (chunk) => {
            // Ctrl+R sends \x12, Ctrl+C sends \x03 (to allow normal exit)
            if (chunk.length && chunk[0] === 0x12) {
                restartServer();
            } else if (chunk.length && chunk[0] === 0x03) {
                // Exit on Ctrl+C
                process.exit();
            }
        });
    }
}
