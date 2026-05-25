import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const response = await fetch(new URL("/pairing/exchange", params.gatewayUrl), {
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

export function saveCloudConfig(configPath: string, nextCloud: NonNullable<DaemonConfig["cloud"]>): DaemonConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> ?? {};
  } catch {
    raw = {};
  }
  raw.cloud = nextCloud;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyYaml(raw), "utf-8");
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
  writeFileSync(configPath, stringifyYaml(raw), "utf-8");
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
    device_token: cloud.device_token ? "<redacted>" : null,
  };
}
