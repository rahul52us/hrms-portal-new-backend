import ipaddr = require("ipaddr.js");

function cleanIp(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[") && raw.includes("]")) return raw.slice(1, raw.indexOf("]"));
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw);
  return ipv4WithPort ? ipv4WithPort[1] : raw;
}

function normalizedAddress(value: string) {
  const address = ipaddr.process(cleanIp(value));
  return address;
}

export function normalizeClientIp(value: unknown) {
  try {
    return normalizedAddress(String(value || "")).toString();
  } catch {
    return "";
  }
}

export function normalizeAllowedNetwork(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Network cannot be empty");
  const slashIndex = raw.indexOf("/");
  try {
    if (slashIndex < 0) {
      const address = normalizedAddress(raw);
      return `${address.toString()}/${address.kind() === "ipv4" ? 32 : 128}`;
    }
    const [rawAddress, rawPrefix] = raw.split("/");
    let address = ipaddr.parse(cleanIp(rawAddress));
    let prefix = Number(rawPrefix);
    if (!Number.isInteger(prefix)) throw new Error("Invalid prefix");
    if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
      if (prefix < 96) throw new Error("IPv4-mapped prefixes must be at least 96");
      address = (address as ipaddr.IPv6).toIPv4Address();
      prefix -= 96;
    }
    const maximum = address.kind() === "ipv4" ? 32 : 128;
    if (prefix < 0 || prefix > maximum) throw new Error("Invalid prefix");
    return `${address.toString()}/${prefix}`;
  } catch {
    throw new Error(`Invalid IP address or CIDR: ${raw}`);
  }
}

export function normalizeAllowedNetworks(values: unknown) {
  if (!Array.isArray(values)) throw new Error("Allowed networks must be an array");
  if (values.length > 100) throw new Error("Allowed networks cannot contain more than 100 entries");
  return Array.from(new Set(values.map(normalizeAllowedNetwork)));
}

export function matchAllowedNetwork(clientIp: unknown, allowedNetworks: string[]) {
  const normalizedIp = normalizeClientIp(clientIp);
  if (!normalizedIp) return { allowed: false, clientIp: "", matchedNetwork: "" };
  const address = ipaddr.parse(normalizedIp);
  for (const configured of allowedNetworks || []) {
    try {
      const normalized = normalizeAllowedNetwork(configured);
      const [networkAddress, prefix] = ipaddr.parseCIDR(normalized);
      if (networkAddress.kind() === address.kind() && (address as any).match(networkAddress as any, prefix)) {
        return { allowed: true, clientIp: normalizedIp, matchedNetwork: normalized };
      }
    } catch {
      continue;
    }
  }
  return { allowed: false, clientIp: normalizedIp, matchedNetwork: "" };
}

export function requestClientIp(req: any) {
  return normalizeClientIp(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress);
}
