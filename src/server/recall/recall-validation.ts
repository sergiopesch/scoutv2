import { isIP } from "node:net";

export const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, "");

export const recallPublicUrl = (baseUrl: string, pathname: string): string =>
  `${trimTrailingSlashes(baseUrl)}${pathname}`;

export const validateRecallVerificationSecret = (
  secret: string,
  label: string
): string => {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("whsec_") || trimmed.length <= "whsec_".length) {
    throw new Error(`${label} must be a Recall whsec_ verification secret`);
  }
  return trimmed;
};

const isNonPublicHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".test") ||
    ["example.com", "example.net", "example.org"].some(
      (reserved) =>
        normalized === reserved || normalized.endsWith(`.${reserved}`)
    ) ||
    isIP(normalized) !== 0
  );
};

const parseHttpsUrl = (value: string, label: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  return parsed;
};

/** Validate and normalize the public origin Recall uses for callbacks. */
export const validateRecallPublicBaseUrl = (value: string): string => {
  const parsed = parseHttpsUrl(value, "Recall public base URL");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "Recall public base URL must be an HTTPS origin without a path, query, or fragment"
    );
  }
  if (isNonPublicHostname(parsed.hostname)) {
    throw new Error(
      "Recall public base URL must use a publicly reachable hostname"
    );
  }
  return parsed.origin;
};

/** Validate the configured Recall API endpoint while allowing a trusted proxy. */
export const validateRecallApiBaseUrl = (value: string): string => {
  const parsed = parseHttpsUrl(value, "Recall API base URL");
  if (parsed.search || parsed.hash) {
    throw new Error("Recall API base URL must not contain a query or fragment");
  }
  return trimTrailingSlashes(parsed.toString());
};

/** Recall rejects local/private meeting URLs at its WAF boundary. */
export const validateRecallMeetingUrl = (value: string): string => {
  const parsed = parseHttpsUrl(value, "Meeting URL");
  if (isNonPublicHostname(parsed.hostname)) {
    throw new Error("Meeting URL must use a publicly reachable hostname");
  }
  return parsed.toString();
};
