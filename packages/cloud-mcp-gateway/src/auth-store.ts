import { randomBytes, randomUUID } from "node:crypto";

interface UserTokenRecord {
  userId: string;
  revoked?: boolean;
}

interface DeviceTokenRecord {
  userId: string;
  runtimeId: string;
  runtimeName?: string;
  revoked?: boolean;
}

interface PairingCodeRecord {
  code: string;
  userId: string;
  expiresAt: number;
}

export interface DeviceTokenIssue {
  userId: string;
  runtimeId: string;
  deviceToken: string;
}

export class InMemoryAuthStore {
  private readonly userTokens = new Map<string, UserTokenRecord>();
  private readonly deviceTokens = new Map<string, DeviceTokenRecord>();
  private readonly pairingCodes = new Map<string, PairingCodeRecord>();

  constructor(seedUserToken?: { token: string; userId: string }) {
    if (seedUserToken) this.addUserToken(seedUserToken.token, seedUserToken.userId);
  }

  addUserToken(token: string, userId: string): void {
    this.userTokens.set(token, { userId });
  }

  authenticateUser(token: string | undefined): string | null {
    if (!token) return null;
    const record = this.userTokens.get(token);
    if (!record || record.revoked) return null;
    return record.userId;
  }

  authenticateDevice(token: string | undefined): DeviceTokenRecord | null {
    if (!token) return null;
    const record = this.deviceTokens.get(token);
    if (!record || record.revoked) return null;
    return record;
  }

  createPairingCode(userId: string, ttlMs = 10 * 60 * 1000): { code: string; expiresAt: number } {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = Date.now() + ttlMs;
    this.pairingCodes.set(code, { code, userId, expiresAt });
    return { code, expiresAt };
  }

  exchangePairingCode(code: string, runtimeName?: string): DeviceTokenIssue {
    const normalized = code.trim().toUpperCase();
    const record = this.pairingCodes.get(normalized);
    if (!record || record.expiresAt < Date.now()) {
      this.pairingCodes.delete(normalized);
      throw new Error("Pairing code is invalid or expired");
    }
    this.pairingCodes.delete(normalized);
    const runtimeId = `rt_${randomUUID()}`;
    const deviceToken = `gsd_dev_${randomBytes(32).toString("hex")}`;
    this.deviceTokens.set(deviceToken, { userId: record.userId, runtimeId, runtimeName });
    return { userId: record.userId, runtimeId, deviceToken };
  }

  revokeDeviceToken(deviceToken: string): boolean {
    const record = this.deviceTokens.get(deviceToken);
    if (!record) return false;
    record.revoked = true;
    return true;
  }
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
