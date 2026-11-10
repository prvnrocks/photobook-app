import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { printAssetUrl } from "@/lib/pdf/print-assets";
import { assetPhotoId, classifyRequest, PRINT_ASSET_ORIGIN } from "@/lib/pdf/request-routing";
import { PROTECTION_BYPASS_HEADER, routePrintRequest } from "@/lib/pdf/render-pdf";
import type { PrintImageLoader } from "@/lib/pdf/images";
import type { HTTPRequest } from "puppeteer-core";

const APP = "https://photobook-git-m8.vercel.app";
const PHOTO = "0b6f3c1e-8f7a-4c2d-9a51-3e2f1d0c9b8a";

describe("classifyRequest", () => {
  it("routes print assets to the loader", () => {
    expect(PRINT_ASSET_ORIGIN).toBe("https://print-assets.invalid");
    expect(classifyRequest(`${PRINT_ASSET_ORIGIN}/${PHOTO}.jpg`, APP)).toBe("asset");
    expect(classifyRequest(`${PRINT_ASSET_ORIGIN}/anything`, APP)).toBe("asset");
  });

  it("continues the app's own origin (route, _next chunks, self-hosted fonts)", () => {
    expect(classifyRequest(`${APP}/print/x?token=a.b`, APP)).toBe("same_origin");
    expect(classifyRequest(`${APP}/_next/static/media/cairo.woff2`, APP)).toBe("same_origin");
    expect(classifyRequest(`${APP}/x`, `${APP}/some/path?q=1`)).toBe("same_origin");
    expect(classifyRequest("http://localhost:3000/print/x", "http://localhost:3000")).toBe("same_origin");
  });

  it("continues same-origin design assets (/design/textures) and nothing more (M10 A5)", () => {
    expect(classifyRequest(`${APP}/design/textures/x.jpg`, APP)).toBe("same_origin");
    expect(classifyRequest(`${APP}/design/textures/paper-cream.jpg`, APP)).toBe("same_origin");
    expect(classifyRequest("http://localhost:3000/design/textures/kraft.jpg", "http://localhost:3000")).toBe(
      "same_origin",
    );
    // Same path on any other origin (incl. the print-asset origin's id-only paths) is unchanged.
    expect(classifyRequest("https://cdn.example/design/textures/x.jpg", APP)).toBe("block");
    expect(classifyRequest(`${PRINT_ASSET_ORIGIN}/design/textures/x.jpg`, APP)).toBe("asset");
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/design/textures/x.jpg`)).toBeNull();
    expect(assetPhotoId(`${APP}/design/textures/x.jpg`)).toBeNull();
  });

  it("blocks other origins, ports, schemes and subdomains", () => {
    expect(classifyRequest("https://fonts.googleapis.com/css2?family=Cairo", APP)).toBe("block");
    expect(classifyRequest("https://fonts.gstatic.com/s/cairo.woff2", APP)).toBe("block");
    expect(classifyRequest("https://evil.example/collect?d=1", APP)).toBe("block");
    expect(classifyRequest("http://photobook-git-m8.vercel.app/x", APP)).toBe("block"); // scheme differs
    expect(classifyRequest("http://localhost:3001/x", "http://localhost:3000")).toBe("block");
    expect(classifyRequest(`https://sub.photobook-git-m8.vercel.app/x`, APP)).toBe("block");
    expect(classifyRequest("https://print-assets.invalid.evil.example/a.jpg", APP)).toBe("block");
    expect(classifyRequest("http://print-assets.invalid/a.jpg", APP)).toBe("block");
    expect(classifyRequest("https://abc.supabase.co/storage/v1/object/sign/photos/x", APP)).toBe("block");
    expect(classifyRequest("file:///etc/passwd", APP)).toBe("block");
    expect(classifyRequest("ws://localhost:3000/_next/webpack-hmr", "http://localhost:3000")).toBe("block");
    expect(classifyRequest("chrome://settings", APP)).toBe("block");
    expect(classifyRequest("not a url", APP)).toBe("block");
    expect(classifyRequest(`${APP}/x`, "not an origin")).toBe("block");
  });

  it("passes data: and blob: through", () => {
    expect(classifyRequest("data:image/png;base64,iVBORw0KGgo=", APP)).toBe("passthrough");
    expect(classifyRequest("DATA:font/woff2;base64,AAAA", APP)).toBe("passthrough");
    expect(classifyRequest(`blob:${APP}/0f1e2d3c`, APP)).toBe("passthrough");
  });
});

describe("assetPhotoId", () => {
  it("extracts the id from printAssetUrl(id), exactly", () => {
    expect(assetPhotoId(printAssetUrl(PHOTO))).toBe(PHOTO);
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/${PHOTO}.jpg?v=2`)).toBe(PHOTO);
    expect(assetPhotoId(printAssetUrl("d3"))).toBe("d3"); // dev-print fixture ids
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/ABC.jpg`)).toBe("ABC"); // no case folding
  });

  it("rejects anything else", () => {
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/${PHOTO}.png`)).toBeNull();
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/x/${PHOTO}.jpg`)).toBeNull();
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/.jpg`)).toBeNull();
    expect(assetPhotoId(printAssetUrl("a b"))).toBeNull(); // encoded space
    expect(assetPhotoId(printAssetUrl("a/../b"))).toBeNull();
    expect(assetPhotoId(`${PRINT_ASSET_ORIGIN}/${"x".repeat(65)}.jpg`)).toBeNull();
    expect(assetPhotoId(`${APP}/${PHOTO}.jpg`)).toBeNull();
    expect(assetPhotoId("garbage")).toBeNull();
  });
});

// --- routePrintRequest with fake puppeteer requests --------------------------------------------

interface Fake {
  req: HTTPRequest;
  calls: { kind: string; arg?: unknown }[];
}

function fakeRequest(url: string, opts: { method?: string; handled?: boolean } = {}): Fake {
  const calls: Fake["calls"] = [];
  const req = {
    url: () => url,
    method: () => opts.method ?? "GET",
    headers: () => ({ accept: "*/*" }),
    isInterceptResolutionHandled: () => opts.handled ?? false,
    respond: vi.fn(async (arg: unknown) => void calls.push({ kind: "respond", arg })),
    continue: vi.fn(async (arg?: unknown) => void calls.push({ kind: "continue", arg })),
    abort: vi.fn(async (arg?: unknown) => void calls.push({ kind: "abort", arg })),
  } as unknown as HTTPRequest;
  return { req, calls };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const loader = (impl: (id: string) => Promise<Buffer>): PrintImageLoader => ({ get: vi.fn(impl) });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("routePrintRequest", () => {
  it("answers assets from the loader as image/jpeg", async () => {
    const l = loader(async () => JPEG);
    const f = fakeRequest(`${PRINT_ASSET_ORIGIN}/${PHOTO}.jpg`);
    routePrintRequest(f.req, { origin: APP, loader: l, bypassSecret: null });
    await flush();
    expect(l.get).toHaveBeenCalledWith(PHOTO);
    expect(f.calls).toEqual([
      {
        kind: "respond",
        arg: expect.objectContaining({ status: 200, contentType: "image/jpeg", body: JPEG }),
      },
    ]);
  });

  it("responds 404 when the loader fails or the asset path is invalid", async () => {
    const failing = loader(async () => {
      throw new Error("decode_failed");
    });
    const a = fakeRequest(`${PRINT_ASSET_ORIGIN}/${PHOTO}.jpg`);
    routePrintRequest(a.req, { origin: APP, loader: failing, bypassSecret: null });
    const b = fakeRequest(`${PRINT_ASSET_ORIGIN}/no/pe.jpg`);
    routePrintRequest(b.req, { origin: APP, loader: failing, bypassSecret: null });
    await flush();
    expect(a.calls).toEqual([{ kind: "respond", arg: expect.objectContaining({ status: 404 }) }]);
    expect(b.calls).toEqual([{ kind: "respond", arg: expect.objectContaining({ status: 404 }) }]);
    expect(failing.get).toHaveBeenCalledTimes(1);
  });

  it("adds the bypass header only to same-origin requests", async () => {
    const l = loader(async () => JPEG);
    const same = fakeRequest(`${APP}/print/x`);
    routePrintRequest(same.req, { origin: APP, loader: l, bypassSecret: "s3cret" });
    const noSecret = fakeRequest(`${APP}/print/x`);
    routePrintRequest(noSecret.req, { origin: APP, loader: l, bypassSecret: null });
    const other = fakeRequest("https://fonts.googleapis.com/css2");
    routePrintRequest(other.req, { origin: APP, loader: l, bypassSecret: "s3cret" });
    const data = fakeRequest("data:image/png;base64,AA==");
    routePrintRequest(data.req, { origin: APP, loader: l, bypassSecret: "s3cret" });
    await flush();
    expect(same.calls).toEqual([
      { kind: "continue", arg: { headers: { accept: "*/*", [PROTECTION_BYPASS_HEADER]: "s3cret" } } },
    ]);
    expect(noSecret.calls).toEqual([{ kind: "continue", arg: undefined }]);
    expect(other.calls).toEqual([{ kind: "abort", arg: "blockedbyclient" }]);
    expect(data.calls).toEqual([{ kind: "continue", arg: undefined }]);
    expect(JSON.stringify([other.calls, data.calls])).not.toContain("s3cret");
  });

  it("ignores already-handled requests and never throws when respond rejects", async () => {
    const l = loader(async () => JPEG);
    const handled = fakeRequest(`${APP}/x`, { handled: true });
    routePrintRequest(handled.req, { origin: APP, loader: l, bypassSecret: null });
    expect(handled.calls).toEqual([]);

    const closing = fakeRequest(`${PRINT_ASSET_ORIGIN}/${PHOTO}.jpg`);
    (closing.req.respond as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Target closed"));
    expect(() => routePrintRequest(closing.req, { origin: APP, loader: l, bypassSecret: null })).not.toThrow();
    await flush();
  });
});
