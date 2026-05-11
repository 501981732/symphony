const REDACTED = "[REDACTED]";

const SECRET_FIELD_NAMES = new Set([
  "password",
  "secret",
  "api_key",
  "apikey",
  "api_secret",
  "access_token",
  "token",
  "private_key",
  "credential",
  "credentials",
  "authorization",
]);

const TOKEN_PATTERNS = [
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /glrt-[A-Za-z0-9_-]{20,}/g,
  /gldt-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+\S+/gi,
  /sk-[A-Za-z0-9]{20,}/g,
];

function redactString(value: string): string {
  let result = value;
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function isSecretFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_FIELD_NAMES.has(lower)) return true;
  if (lower.endsWith("_token") && lower !== "token_env") return false;
  if (lower === "password" || lower === "secret" || lower === "api_key") return true;
  return SECRET_FIELD_NAMES.has(lower);
}

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (isSecretFieldName(key) && typeof val === "string") {
      result[key] = REDACTED;
    } else {
      result[key] = redact(val);
    }
  }

  return result;
}
