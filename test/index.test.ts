import { describe, it, expect } from "vitest";
import { verifyWebhookSignature } from "../src/worker/github";

describe("verifyWebhookSignature", () => {
  it("rejects empty signatures", async () => {
    const valid = await verifyWebhookSignature("secret", "payload", "");
    expect(valid).toBe(false);
  });

  it("rejects wrong signatures", async () => {
    const valid = await verifyWebhookSignature(
      "secret",
      "payload",
      "sha256=wrong",
    );
    expect(valid).toBe(false);
  });

  it("accepts valid signatures", async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode("test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode("test-payload"),
    );
    const hex = [...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const valid = await verifyWebhookSignature(
      "test-secret",
      "test-payload",
      `sha256=${hex}`,
    );
    expect(valid).toBe(true);
  });
});
