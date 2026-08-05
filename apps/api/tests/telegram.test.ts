import { describe, expect, it } from "vitest";
import { telegramStartPayload } from "../src/telegram.js";

describe("telegramStartPayload", () => {
  it("extracts the contact payload from a private bot start command", () => {
    expect(telegramStartPayload("/start contact_12345678-1234-1234-1234-123456789abc")).toBe(
      "contact_12345678-1234-1234-1234-123456789abc"
    );
  });

  it("accepts commands containing the bot username", () => {
    expect(telegramStartPayload("/start@meip_bot contact_abc")).toBe("contact_abc");
  });

  it("returns no payload when the bot is started without a connection link", () => {
    expect(telegramStartPayload("/start")).toBeNull();
  });

  it("ignores regular Telegram messages", () => {
    expect(telegramStartPayload("olá")).toBeNull();
  });
});
