export interface RedactionOptions {
  internalDomains?: string[];
  internalCidrs?: string[];
}

export interface RedactionResult {
  text: string;
  count: number;
  version: 1;
}

const replacement = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ipv4ToInteger(value: string): number | null {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts.reduce((result, part) => ((result << 8) | part) >>> 0, 0);
}

function isInCidr(ip: string, cidr: string): boolean {
  const [networkText, prefixText] = cidr.split("/");
  const ipValue = ipv4ToInteger(ip);
  const network = networkText ? ipv4ToInteger(networkText) : null;
  const prefix = Number(prefixText);
  if (
    ipValue === null ||
    network === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipValue & mask) === (network & mask);
}

export function redactText(
  input: string,
  options: RedactionOptions = {},
): RedactionResult {
  let text = input;
  let count = 0;
  const replace = (
    pattern: RegExp,
    replacer: string | ((match: string, ...groups: string[]) => string),
  ) => {
    text = text.replace(pattern, (...args: unknown[]) => {
      count += 1;
      if (typeof replacer === "string") return replacer;
      return replacer(args[0] as string, ...(args.slice(1, -2) as string[]));
    });
  };

  replace(
    /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu,
    replacement,
  );
  replace(
    /(authorization\s*:\s*bearer\s+)[^\s]+/giu,
    (_match, prefix) => `${prefix}${replacement}`,
  );
  replace(
    /((?:"(?:password|passwd|pwd)"|'(?:password|passwd|pwd)'|(?:password|passwd|pwd))\s*[=:]\s*)(["'])([\s\S]*?)\2/giu,
    (_match, prefix, quote) => `${prefix}${quote}${replacement}${quote}`,
  );
  replace(
    /((?:password|passwd|pwd)\s*[=:]\s*)[^\s&;]+/giu,
    (_match, prefix) => `${prefix}${replacement}`,
  );
  replace(
    /((?:access[_-]?token|api[_-]?key|x-amz-signature|x-goog-signature|signature|sig)\s*[=:]\s*)[^\s&;]+/giu,
    (_match, prefix) => `${prefix}${replacement}`,
  );
  replace(
    /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    (_match, scheme) => `${scheme}${replacement}@`,
  );
  replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, replacement);

  for (const domain of options.internalDomains ?? []) {
    if (!domain.trim()) continue;
    replace(
      new RegExp(`\\b(?:[a-z0-9-]+\\.)*${escapeRegExp(domain)}\\b`, "giu"),
      replacement,
    );
  }

  const cidrs = options.internalCidrs ?? [];
  if (cidrs.length > 0) {
    replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, (ip) =>
      cidrs.some((cidr) => isInCidr(ip, cidr)) ? replacement : ip,
    );
    // The replacement callback is invoked for every IPv4 candidate; compensate public addresses.
    const candidates = input.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) ?? [];
    count -= candidates.filter(
      (ip) => !cidrs.some((cidr) => isInCidr(ip, cidr)),
    ).length;
  }

  return { text, count, version: 1 };
}
