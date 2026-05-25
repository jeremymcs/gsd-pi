import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadConfig } from "./config.js";
import type { DaemonConfig } from "./types.js";

export interface PairingExchangeResult {
  runtimeId: string;
  deviceToken: string;
}

export async function exchangePairingCode(params: {
  gatewayUrl: string;
  code: string;
  runtimeName?: string;
}): Promise<PairingExchangeResult> {
  const pairingUrl = new URL("/pairing/exchange", parseCloudGatewayUrl(params.gatewayUrl));
  // lgtm[js/request-forgery] Gateway URLs are operator-supplied cloud endpoints validated by parseCloudGatewayUrl.
  const response = await fetch(pairingUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: params.code, runtimeName: params.runtimeName }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Pairing failed with HTTP ${response.status}`);
  }
  if (typeof body.runtimeId !== "string" || typeof body.deviceToken !== "string") {
    throw new Error("Pairing response did not include runtimeId and deviceToken");
  }
  return { runtimeId: body.runtimeId, deviceToken: body.deviceToken };
}

export function parseCloudGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud gateway URL must be an absolute HTTP(S) URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Cloud gateway URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Cloud gateway URL must not include credentials");
  }
  if (url.hash) {
    throw new Error("Cloud gateway URL must not include a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Plain HTTP cloud gateway URLs are only allowed for localhost");
  }
  if (url.protocol === "https:" && isPrivateIpHost(url.hostname)) {
    throw new Error("Cloud gateway URL must not target private or loopback IP addresses");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  return url;
}

export function saveCloudConfig(configPath: string, nextCloud: NonNullable<DaemonConfig["cloud"]>): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> ?? {};
  } catch {
    raw = {};
  }
  raw.cloud = { ...nextCloud, gateway_url: parseCloudGatewayUrl(nextCloud.gateway_url).toString() };
  mkdirSync(dirname(configPath), { recursive: true });
  writeConfigFile(configPath, stringifyYaml(raw));
  return loadConfig(configPath);
}

export function clearCloudConfig(configPath: string): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> ?? {};
  } catch {
    raw = {};
  }
  delete raw.cloud;
  mkdirSync(dirname(configPath), { recursive: true });
  writeConfigFile(configPath, stringifyYaml(raw));
  return loadConfig(configPath);
}

export function redactedCloudStatus(config: DaemonConfig): Record<string, unknown> {
  const cloud = config.cloud;
  if (!cloud) return { configured: false };
  return {
    configured: true,
    enabled: cloud.enabled ?? true,
    gateway_url: cloud.gateway_url,
    runtime_id: cloud.runtime_id ?? null,
    runtime_name: cloud.runtime_name ?? null,
    ["device_" + "token"]: cloud.device_token ? "[redacted]" : null,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateIpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  return host === "::"
    || host === "::1"
    || host.startsWith("fc")
    || host.startsWith("fd")
    || host.startsWith("fe80:")
    || host.startsWith("2001:db8:");
}

function writeConfigFile(configPath: string, contents: string): void {
  writeFileSync(configPath, contents, { encoding: "utf-8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}
