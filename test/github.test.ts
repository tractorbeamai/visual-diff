import { describe, it, expect } from "vitest";
import { parsePRUrl } from "../src/worker/github";

describe("parsePRUrl", () => {
  it.each([
    [
      "https://github.com/owner/repo/pull/123",
      { owner: "owner", repo: "repo", prNumber: 123 },
    ],
    [
      "https://github.com/owner/repo/pull/456/files",
      { owner: "owner", repo: "repo", prNumber: 456 },
    ],
    [
      "https://github.com/my-org/my.repo/pull/1",
      { owner: "my-org", repo: "my.repo", prNumber: 1 },
    ],
  ])("parses %s", (url, expected) => {
    expect(parsePRUrl(url)).toEqual(expected);
  });

  it.each([
    "https://github.com/owner/repo",
    "https://example.com",
    "not a url",
  ])("returns null for %s", (url) => {
    expect(parsePRUrl(url)).toBeNull();
  });
});
