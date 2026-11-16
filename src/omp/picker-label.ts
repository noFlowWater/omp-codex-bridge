import { utf8Preview } from "./presentation.ts";

// Escape controls and directional overrides before untrusted values reach terminal labels.
export function pickerLabel(value: unknown, bytes = 160) {
  const preview = utf8Preview(String(value ?? ""), bytes);
  return JSON.stringify(preview.text).slice(1, -1)
    .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    + (preview.truncated ? "…" : "");
}
