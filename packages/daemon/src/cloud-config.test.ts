import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { redactedCloudStatus, saveCloudConfig } from "./cloud-config.js";

test("cloud config stores device token but redacts status output", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-config-"));
  const configPath = join(dir, "daemon.yaml");
  const config = saveCloudConfig(configPath, {
    gateway_url: "https://gateway.example",
    device_token: "secret-device-token",
    runtime_id: "rt1",
    runtime_name: "Laptop",
    enabled: true,
  });

  assert.match(readFileSync(configPath, "utf8"), /secret-device-token/);
  assert.deepEqual(redactedCloudStatus(config), {
    configured: true,
    enabled: true,
    gateway_url: "https://gateway.example",
    runtime_id: "rt1",
    runtime_name: "Laptop",
    device_token: "<redacted>",
  });
});
