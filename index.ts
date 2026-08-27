/**
 * pi-paste-image-to-model
 *
 * Paste an image with a shortcut (default ctrl+v). When you submit, the
 * image — together with the tail of the recent conversation and your turn's
 * text — is relayed to a vision (VL) model from your Pi model registry. The
 * VL model's analysis is injected into the main (text-only) model's context
 * as a persistent custom message, so the main model "sees" the image as text.
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
 *          / _HISTORY_CHARS
 *          (_MODEL accepts "provider/modelId" or a bare model id)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
        "Be thorough and structured. This description is the primary model's only view of the image.",
      ].join("\n");

      const response = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: promptText },
                ...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
              ],
              timestamp: Date.now(),
            },
          ],
        },
        { cacheRetention: "none" },
      );

      const description = response.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (!description) {
        if (ctx.hasUI) ctx.ui.notify("pi-paste-image-to-model: VL model returned no text", "warning");
        return;
      }
      return {
        message: {
          customType: "pi-paste-image-to-model",
          content: `[Image relay — ${cfg.provider}/${cfg.model} analysis]\n${description}`,
          display: true,
        },
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
}
