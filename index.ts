/**
 * pi-paste-image-to-model
 *
 * Paste an image with a shortcut (default ctrl+v). When you submit, the
 * image — together with the tail of the recent conversation and your turn's
 * text — is relayed to a vision (VL) model from your Pi model registry. The
 * VL model's analysis is injected into the main (text-only) model's context
 * as a persistent custom message, so the main model "sees" the image as text.
 *
 * The extension also registers an `image_relay` tool the agent can call
 * directly: image_relay({ path, prompt? }) sends an image file to the VL
 * model and returns the analysis as a tool result.
 *
 * Trigger mechanism (shortcut + clipboard read + queue + marker + `input`
 * transform) is based on pi-image-tools by MasuRii:
 * https://github.com/MasuRii/pi-image-tools
 *
 * Configuration (all optional, see README.md):
 *   file:  ~/.pi/agent/paste-image-to-model.json
 *     { "enabled": true, "shortcut": "ctrl+v",
 *       "provider": "my-vl-provider", "model": "my-vl-model",
 *       "historyChars": 4000, "marker": "[image queued]" }
 *   env:   PI_PASTE_IMAGE_TO_MODEL_ENABLED / _SHORTCUT / _PROVIDER / _MODEL
 *          / _HISTORY_CHARS / _RELAY_TIMEOUT_MS / _VL_MAX_TOKENS
 *          (_MODEL accepts "provider/modelId" or a bare model id)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ------------------------------------------------------------------ config

const CONFIG_FILE_NAME = "paste-image-to-model.json";
const ENV_PREFIX = "PI_PASTE_IMAGE_TO_MODEL_";

export interface PasteImageToModelConfig {
  enabled: boolean;
  shortcut: string;
  /** Provider id from models.json. Required for relaying. */
  provider?: string;
  /** Model id from models.json. Required for relaying. */
  model?: string;
  /** How many trailing characters of the conversation to send to the VL model. */
  historyChars: number;
  /** Marker inserted into the editor when an image is queued. */
  marker: string;
  /** Hard timeout (ms) for the VL model call. The turn proceeds if it expires. */
  relayTimeoutMs: number;
  /** Max tokens the VL model may generate for a description. */
  vlMaxTokens: number;
}

export function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load config with defaults. File values win, env vars override the file. */
export function loadConfig(): PasteImageToModelConfig {
  const cfg: PasteImageToModelConfig = {
    enabled: true,
    shortcut: "ctrl+v",
    provider: undefined,
    model: undefined,
    historyChars: 4000,
    marker: "[image queued]",
    relayTimeoutMs: 120000,
    vlMaxTokens: 1024,
  };

  const path = getConfigPath();
  if (existsSync(path)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (isRecord(raw)) {
        if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
        if (typeof raw.shortcut === "string" && raw.shortcut.trim().length > 0) {
          cfg.shortcut = raw.shortcut.trim();
        }
        if (typeof raw.provider === "string" && raw.provider.trim().length > 0) {
          cfg.provider = raw.provider.trim();
        }
        if (typeof raw.model === "string" && raw.model.trim().length > 0) {
          cfg.model = raw.model.trim();
        }
        if (
          typeof raw.historyChars === "number" &&
          Number.isFinite(raw.historyChars) &&
          raw.historyChars >= 0
        ) {
          cfg.historyChars = Math.floor(raw.historyChars);
        }
        if (typeof raw.marker === "string" && raw.marker.length > 0) {
          cfg.marker = raw.marker;
        }
        if (
          typeof raw.relayTimeoutMs === "number" &&
          Number.isFinite(raw.relayTimeoutMs) &&
          raw.relayTimeoutMs >= 1000
        ) {
          cfg.relayTimeoutMs = Math.floor(raw.relayTimeoutMs);
        }
        if (
          typeof raw.vlMaxTokens === "number" &&
          Number.isFinite(raw.vlMaxTokens) &&
          raw.vlMaxTokens > 0
        ) {
          cfg.vlMaxTokens = Math.floor(raw.vlMaxTokens);
        }
      }
    } catch (error) {
      console.warn(
        `[pi-paste-image-to-model] failed to read config at ${path}: ${
          error instanceof Error ? error.message : String(error)
        } — using defaults`,
      );
    }
  }

  const env = (name: string): string | undefined => {
    const value = process.env[`${ENV_PREFIX}${name}`];
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  const shortcut = env("SHORTCUT");
  if (shortcut) cfg.shortcut = shortcut;

  const provider = env("PROVIDER");
  if (provider) cfg.provider = provider;

  const model = env("MODEL");
  if (model) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      cfg.provider = model.slice(0, slash).trim();
      cfg.model = model.slice(slash + 1).trim();
    } else {
      cfg.model = model;
    }
  }

  const historyChars = env("HISTORY_CHARS");
  if (historyChars && /^\d+$/.test(historyChars)) {
    cfg.historyChars = parseInt(historyChars, 10);
  }

  const relayTimeoutMs = env("RELAY_TIMEOUT_MS");
  if (relayTimeoutMs && /^\d+$/.test(relayTimeoutMs) && parseInt(relayTimeoutMs, 10) >= 1000) {
    cfg.relayTimeoutMs = parseInt(relayTimeoutMs, 10);
  }

  const vlMaxTokens = env("VL_MAX_TOKENS");
  if (vlMaxTokens && /^\d+$/.test(vlMaxTokens) && parseInt(vlMaxTokens, 10) > 0) {
    cfg.vlMaxTokens = parseInt(vlMaxTokens, 10);
  }

  return cfg;
}

// ---------------------------------------------------- clipboard (macOS PNGf)
// Same osascript «class PNGf» mechanism as pi-image-tools' macOS provider.

const PNGF_SCRIPT = `try
  set imageData to the clipboard as «class PNGf»
  return imageData
on error
  return ""
end try`;

const TEXT_SCRIPT = `try
  return the clipboard as text
on error
  return ""
end try`;

function runOsascript(script: string, timeoutMs = 15000): string | null {
  try {
    const res = spawnSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) return null;
    const out = (res.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function readClipboardImage(): { data: string; mimeType: string } | null {
  if (process.platform !== "darwin") return null;
  const out = runOsascript(PNGF_SCRIPT);
  if (!out) return null;
  const match = out.match(/«data\s+PNGf([0-9a-fA-F\s]+)»/i);
  if (!match) return null;
  const hex = (match[1] ?? "").replace(/\s+/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0) return null;
  // PNGf normally returns real PNG; sniff JPEG as a safety net
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return {
    data: bytes.toString("base64"),
    mimeType: isJpeg ? "image/jpeg" : "image/png",
  };
}

function readClipboardText(): string | null {
  if (process.platform !== "darwin") return null;
  return runOsascript(TEXT_SCRIPT);
}

// ------------------------------------------------------- history excerpt

function conversationTail(sessionManager: any, maxChars: number): string {
  if (maxChars <= 0) return "";
  const entries = sessionManager.getBranch?.() ?? [];
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.message?.role) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const lines: string[] = [];
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const text = content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
    if (role === "assistant") {
      for (const b of content) {
        if (b?.type === "toolCall" && typeof b.name === "string") {
          lines.push(`(called tool ${b.name} with ${JSON.stringify(b.arguments ?? {})})`);
        }
      }
    }
    if (lines.length > 0) sections.push(lines.join("\n"));
  }
  const full = sections.join("\n\n");
  return full.length > maxChars ? full.slice(-maxChars) : full;
}

function countOccurrences(text: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const index = text.indexOf(token, cursor);
    if (index === -1) return count;
    count += 1;
    cursor = index + token.length;
  }
}

// ------------------------------------------------- image file type sniffing

function sniffImageMime(bytes: Buffer, fallbackExt: string): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length > 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  const ext = fallbackExt.toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

// --------------------------------------------------------- shared VL call
// One shared path for the paste relay and the image_relay tool. Bounded by
// relayTimeoutMs (JS-side timer + provider timeoutMs) and an AbortSignal, so
// a slow or stuck VL server can never wedge the agent: on timeout the turn
// continues without the image.

async function relayToVL(
  ctx: any,
  cfg: PasteImageToModelConfig,
  model: any,
  images: { data: string; mimeType: string }[],
  promptText: string,
  outerSignal?: AbortSignal,
): Promise<{ text?: string; error?: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("relay timeout"));
  }, cfg.relayTimeoutMs);
  let onAbort: (() => void) | undefined;
  if (outerSignal) {
    onAbort = () => controller.abort(new Error("aborted"));
    if (outerSignal.aborted) onAbort();
    else outerSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: promptText },
              ...images.map((img) => ({
                type: "image" as const,
                data: img.data,
                mimeType: img.mimeType,
              })),
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        cacheRetention: "none",
        maxTokens: cfg.vlMaxTokens,
        timeoutMs: cfg.relayTimeoutMs,
        signal: controller.signal,
      },
    );
    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    return text ? { text } : { error: "VL model returned no text" };
  } catch (error) {
    if (timedOut) {
      return {
        error: `VL model timed out after ${Math.round(cfg.relayTimeoutMs / 1000)}s — image not relayed`,
      };
    }
    if (controller.signal.aborted) return { error: "cancelled" };
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (outerSignal && onAbort) outerSignal.removeEventListener("abort", onAbort);
  }
}

// ------------------------------------------------------------------ plugin

export default function pasteImageToModel(pi: ExtensionAPI): void {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const marker = cfg.marker;
  const pending: { data: string; mimeType: string }[] = [];

  pi.on("session_start", () => {
    pending.length = 0;
  });

  pi.registerShortcut(cfg.shortcut, {
    description: "Paste image from clipboard (relayed to VL model with recent context)",
    handler: async (ctx) => {
      const image = readClipboardImage();
      if (!image) {
        // Fall back to text so the key still behaves like a normal paste
        const text = readClipboardText();
        if (text && ctx.hasUI) {
          ctx.ui.pasteToEditor(text);
        } else if (ctx.hasUI) {
          ctx.ui.notify("No image or text found in clipboard.", "warning");
        }
        return;
      }
      pending.push(image);
      if (ctx.hasUI) {
        ctx.ui.pasteToEditor(`${marker} `);
        ctx.ui.notify(
          `Image queued (${image.mimeType}, ${Math.round(image.data.length * 0.75 / 1024)} KB). Add your message, then submit.`,
          "info",
        );
      }
    },
  });

  // Strip the marker on submit. The image stays in the queue and is NOT
  // attached to the user message — the main model cannot see it; the relay
  // in before_agent_start turns it into a text description instead.
  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (pending.length === 0) return { action: "continue" as const };
    const count = countOccurrences(event.text, marker);
    if (count === 0) {
      pending.length = 0; // marker not present: user discarded the attachment
      return { action: "continue" as const };
    }
    const text = event.text
      .split(marker)
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { action: "transform" as const, text };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (pending.length === 0) return;
    const images = pending.splice(0);

    if (!cfg.provider || !cfg.model) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-paste-image-to-model: no VL model configured. Set "provider" and "model" in ${getConfigPath()} (see config.example.json). Image was not relayed.`,
          "error",
        );
      }
      return;
    }

    const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
    if (!model) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-paste-image-to-model: model ${cfg.provider}/${cfg.model} not found in model registry. Check your models.json.`,
          "error",
        );
      }
      return;
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-paste-image-to-model: no auth configured for ${cfg.provider}/${cfg.model}.`,
          "error",
        );
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(`Relaying ${images.length} image(s) to ${cfg.provider}/${cfg.model}…`, "info");
    }

    const startedAt = Date.now();
    try {
      const history = conversationTail(ctx.sessionManager, cfg.historyChars);
      const promptText = [
        "The primary model is text-only and cannot see images. You are its image relay.",
        "",
        "Recent conversation (tail):",
        "<chat>",
        history || "(empty)",
        "</chat>",
        "",
        "User's current message:",
        "<prompt>",
        event.prompt?.trim() || "(no text — image only)",
        "</prompt>",
        "",
        "The attached image(s) follow. Describe what each shows in full detail:",
        "- all visible text, transcribed verbatim (code, errors, UI labels, numbers)",
        "- layout and notable visual elements",
        "- anything the user's current message points at",
        "Be thorough but concise (under ~200 words) unless the image contains dense text (code, tables, logs) that must be transcribed verbatim.",
        "This description is the primary model's only view of the image.",
      ].join("\n");

      const result = await relayToVL(ctx, cfg, model, images, promptText);
      if (result.error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-paste-image-to-model: ${result.error}. The turn continues without the image.`,
            "error",
          );
        }
        return;
      }
      const description = result.text;
      if (ctx.hasUI) {
        ctx.ui.notify(`Relay done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`, "info");
      }
      return {
        message: {
          customType: "pi-paste-image-to-model",
          content: `[Image relay — ${cfg.provider}/${cfg.model} description of the image(s) the user pasted]\n${description}`,
          display: true,
        },
        // APPEND to the base prompt — returning a bare fragment would
        // REPLACE it for the turn (docs: "Replace the system prompt for
        // this turn"), stripping the agent's tools/identity/rules.
        systemPrompt:
          (typeof event.systemPrompt === "string" ? event.systemPrompt : "") +
          "\n\n" +
          [
            "The user attached image(s) this turn that you cannot see (you are text-only).",
            "The custom message '[Image relay — …]' contains the vision model's description of those image(s).",
            "Treat that description as the image's contents for this turn: answer questions about the image from it and quote relevant parts when asked.",
            "Do not claim to have seen the pixels, and do not invent visual details that are not in the description.",
            "The description comes from another model and may contain small errors or omissions; if it conflicts with what the user said, trust the user and ask for clarification.",
            "If the description is missing something the user's question needs, ask the user to re-describe or re-paste the image.",
          ].join(" "),
      };
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-paste-image-to-model: relay failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }
  });

  // ------------------------------------------------------------------ tool
  // The agent can relay images itself: image_relay({ path, prompt? }) reads
  // an image file, sends it to the configured VL model, and returns the
  // analysis as a normal tool result — no pixels reach the main model.
  pi.registerTool({
    name: "image_relay",
    label: "Image Relay",
    description: [
      "Send an image file to the configured vision model and return its detailed text description of the image.",
      "You cannot see images yourself: the returned text is your only view of the image's contents.",
      "It is a third-party model's reading and may contain minor errors or omissions; if it conflicts with what the user said, trust the user and ask for clarification.",
      "Use when you need to see a screenshot, photo, or diagram you cannot read directly.",
    ].join(" "),
    promptSnippet:
      "Inspect an image file via the configured vision model (returns a text description to treat as the image's contents)",
    promptGuidelines: [
      "When image_relay returns, treat its text as the image's contents for the rest of the turn: answer from it, quote relevant parts, and do not claim to see pixels beyond what it describes.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to the image file (png/jpg/webp/gif). Relative paths resolve against the working directory.",
      }),
      prompt: Type.Optional(
        Type.String({
          description: "Optional question or context for the vision model about the image.",
        }),
      ),
    }),
    async execute(_toolCallId, params: any, signal: any, onUpdate: any, ctx: any) {
      const err = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: { error: text },
      });

      if (signal?.aborted) return err("image_relay: cancelled.");
      if (!cfg.provider || !cfg.model) {
        return err(
          `image_relay: no VL model configured — set "provider" and "model" in ${getConfigPath()} (see config.example.json).`,
        );
      }
      const model = ctx.modelRegistry?.find?.(cfg.provider, cfg.model);
      if (!model) {
        return err(
          `image_relay: model ${cfg.provider}/${cfg.model} not found in model registry. Check your models.json.`,
        );
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        return err(`image_relay: no auth configured for ${cfg.provider}/${cfg.model}.`);
      }

      let rawPath = typeof params?.path === "string" ? params.path.trim() : "";
      if (rawPath.startsWith("@")) rawPath = rawPath.slice(1); // some models prefix paths with @
      if (rawPath.length === 0) return err('image_relay: missing required parameter "path".');
      const absPath = resolve(ctx.cwd ?? process.cwd(), rawPath);
      if (!existsSync(absPath)) return err(`image_relay: file not found: ${absPath}`);
      let stats;
      try {
        stats = statSync(absPath);
      } catch {
        return err(`image_relay: cannot read file: ${absPath}`);
      }
      if (!stats.isFile()) return err(`image_relay: not a file: ${absPath}`);
      if (stats.size > 15 * 1024 * 1024) {
        return err(`image_relay: image too large (>15MB): ${absPath}`);
      }

      const bytes = readFileSync(absPath);
      const mimeType = sniffImageMime(bytes, extname(absPath));
      if (!mimeType) return err(`image_relay: unsupported image type (png/jpg/webp/gif): ${absPath}`);

      onUpdate?.({
        content: [{ type: "text" as const, text: `Relaying ${rawPath} to ${cfg.provider}/${cfg.model}…` }],
      });

      const promptText = [
        "You are a vision model acting as the eyes of a text-only coding agent.",
        "Analyze the attached image in full detail:",
        "- all visible text, transcribed verbatim (code, errors, UI labels, numbers)",
        "- layout and notable visual elements",
        "Be thorough but concise (under ~200 words) unless dense text must be transcribed verbatim.",
        typeof params?.prompt === "string" && params.prompt.trim().length > 0
          ? `The agent's question/context: ${params.prompt.trim()}`
          : "Focus on what is most likely relevant to the agent's current task.",
      ].join("\n");

      const result = await relayToVL(
        ctx,
        cfg,
        model,
        [{ data: bytes.toString("base64"), mimeType }],
        promptText,
        signal,
      );
      if (result.error) return err(`image_relay: ${result.error}.`);
      const text = result.text;
      return {
        content: [
          {
            type: "text" as const,
            text: `[image_relay — ${cfg.provider}/${cfg.model} description of "${rawPath}"; treat this text as the image's contents]\n${text}`,
          },
        ],
        details: { model: `${cfg.provider}/${cfg.model}`, image: rawPath },
      };
    },
  });
}
