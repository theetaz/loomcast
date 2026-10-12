import { describe, expect, it } from "vitest";
import { bridgeUrl, normalizeServerUrl, ServerUrlError } from "../src/server-url";

describe("normalizeServerUrl", () => {
  it("keeps only the origin of an https URL", () => {
    expect(normalizeServerUrl(" https://loomcast.example.com/settings?x=1 ")).toBe(
      "https://loomcast.example.com",
    );
  });

  it("allows plain http only for loopback hosts", () => {
    expect(normalizeServerUrl("http://localhost:8790")).toBe("http://localhost:8790");
    expect(normalizeServerUrl("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790");
    expect(() => normalizeServerUrl("http://loomcast.example.com")).toThrow(ServerUrlError);
  });

  it("rejects other schemes, credentials and garbage", () => {
    expect(() => normalizeServerUrl("ftp://example.com")).toThrow(ServerUrlError);
    expect(() => normalizeServerUrl("https://user:pw@example.com")).toThrow(ServerUrlError);
    expect(() => normalizeServerUrl("not a url")).toThrow(ServerUrlError);
  });
});

describe("bridgeUrl", () => {
  it("maps https to wss and http to ws on the bridge path", () => {
    expect(bridgeUrl("https://loomcast.example.com/app")).toBe(
      "wss://loomcast.example.com/bridge/v1",
    );
    expect(bridgeUrl("http://127.0.0.1:8790")).toBe("ws://127.0.0.1:8790/bridge/v1");
  });
});
