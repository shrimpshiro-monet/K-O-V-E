type DiagnosticLevel = "info" | "warn" | "error";

const SECRET_KEY = /^(?:api.?key|x.?api.?key|authorization|(?:access|refresh|api|provider)?[_-]?token|password|secret|credential|credentials)$/i;

function sanitizeDiagnosticValue(
  value: unknown,
  key = "",
  seen = new WeakSet<object>(),
): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";

  if (typeof value === "string") {
    const safeText = value.replace(
      /data:([^;,\s]+);base64,([a-z0-9+/=\r\n]+)/gi,
      (_match, mimeType: string, encoded: string) =>
        `data:${mimeType};base64,[base64 omitted: ${encoded.length} characters]`,
    );
    if (safeText !== value) return safeText;
    if (/base64/i.test(key) || (/^data$/i.test(key) && value.length > 256)) {
      return `[binary omitted: ${value.length} characters]`;
    }
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { type: value.type, size: value.size, data: "[binary omitted]" };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "ArrayBuffer", byteLength: value.byteLength, data: "[binary omitted]" };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      byteLength: value.byteLength,
      data: "[binary omitted]",
    };
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, "", seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeDiagnosticValue(entryValue, entryKey, seen),
    ]),
  );
}

export function sanitizeAIDiagnosticPayload(value: unknown): unknown {
  return sanitizeDiagnosticValue(value);
}

export function logAIDiagnostic(
  event: string,
  payload: unknown,
  level: DiagnosticLevel = "info",
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    ...(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? sanitizeAIDiagnosticPayload(payload) as Record<string, unknown>
        : { detail: sanitizeAIDiagnosticPayload(payload) }
    ),
  };
  const message = `[KOVE AI] ${event}`;
  if (level === "error") {
    console.error(message, entry);
  } else if (level === "warn") {
    console.warn(message, entry);
  } else {
    // Always-on diagnostics are the requested browser-console trace.
    // eslint-disable-next-line no-console
    console.info(message, entry);
  }
}
