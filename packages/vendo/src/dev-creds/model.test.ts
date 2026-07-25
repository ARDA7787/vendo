import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevModelController, devModel, importHostModule, NO_CREDENTIAL_MESSAGE } from "./model.js";

describe("devModel (env-resolving default model)", () => {
  it("is an ai-SDK LanguageModel", () => {
    const model = devModel({ env: {} });
    const record = model as unknown as Record<string, unknown>;
    expect(record.specificationVersion).toBe("v3");
    expect(record.provider).toBe("vendo-dev");
    expect(typeof record.doGenerate).toBe("function");
    expect(typeof record.doStream).toBe("function");
  });

  it("fails every call with the honest instructions when nothing is available", async () => {
    const model = devModel({ env: {} });
    const record = model as unknown as {
      doGenerate(options: unknown): Promise<unknown>;
      doStream(options: unknown): Promise<unknown>;
    };
    await expect(record.doGenerate({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
    // doStream rejects with the same message (streamText's error path shows
    // the generic error part; the operator log carries this one).
    await expect(record.doStream({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
  });

  it("serves the vendo-cloud rung through @ai-sdk/anthropic pointed at the Cloud gateway", async () => {
    const seen: Array<{ apiKey: string; baseURL: string }> = [];
    const controller = new DevModelController({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: async (_root, specifier) => {
        expect(specifier).toBe("@ai-sdk/anthropic");
        return {
          createAnthropic: (config: { apiKey: string; baseURL: string }) => {
            seen.push(config);
            return (modelId: string) => ({
              specificationVersion: "v3",
              provider: "anthropic",
              modelId,
              supportedUrls: {},
              doGenerate: async (options: unknown) => ({ delegated: "generate", modelId, options }),
              doStream: async (options: unknown) => ({ delegated: "stream", modelId, options }),
            });
          },
        };
      },
    });
    const callOptions = { prompt: [] };
    // The gateway serves curated aliases only; vendo-default is the SDK's
    // default (raw claude-* ids would be grace-remapped server-side).
    expect(await controller.doGenerate(callOptions)).toEqual({
      delegated: "generate",
      modelId: "vendo-default",
      options: callOptions,
    });
    expect(await controller.doStream(callOptions)).toEqual({
      delegated: "stream",
      modelId: "vendo-default",
      options: callOptions,
    });
    // The key rides as the provider apiKey; the base is the production
    // console's /api/v1, where the Anthropic-shaped /messages endpoint lives.
    expect(seen).toEqual([
      { apiKey: "vnd_x", baseURL: "https://console.vendo.run/api/v1" },
    ]);
  });

  it("honors VENDO_CLOUD_URL and the VENDO_CLOUD_MODEL alias override on the vendo-cloud rung", async () => {
    const seen: Array<{ baseURL: string }> = [];
    const controller = new DevModelController({
      env: {
        VENDO_API_KEY: "vnd_x",
        VENDO_CLOUD_URL: "http://localhost:3001/",
        VENDO_CLOUD_MODEL: "vendo-strong",
        // The anthropic env-key override must NOT leak onto the cloud rung.
        VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8",
      },
      importModule: async () => ({
        createAnthropic: (config: { apiKey: string; baseURL: string }) => {
          seen.push({ baseURL: config.baseURL });
          return (modelId: string) => ({
            specificationVersion: "v3",
            provider: "anthropic",
            modelId,
            supportedUrls: {},
            doGenerate: async () => ({ modelId }),
            doStream: async () => ({ modelId }),
          });
        },
      }),
    });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ modelId: "vendo-strong" });
    expect(seen).toEqual([{ baseURL: "http://localhost:3001/api/v1" }]);
  });

  it("names the missing anthropic install when the vendo-cloud rung lacks the provider", async () => {
    const controller = new DevModelController({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: async (_root, specifier) => {
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/@ai-sdk\/anthropic@\^3/);
  });

  it("names the missing provider install for an env-key rung without the package", async () => {
    const controller = new DevModelController({
      env: { OPENAI_API_KEY: "sk-o" },
      importModule: async (_root, specifier) => {
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/@ai-sdk\/openai@\^3/);
  });

  it("delegates env-key calls to the host provider model with full fidelity", async () => {
    const seen: unknown[] = [];
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a" },
      importModule: async () => ({
        createAnthropic: (config: { apiKey: string }) => {
          seen.push(config.apiKey);
          return (modelId: string) => ({
            specificationVersion: "v3",
            provider: "anthropic",
            modelId,
            supportedUrls: {},
            doGenerate: async (options: unknown) => ({ delegated: "generate", options }),
            doStream: async (options: unknown) => ({ delegated: "stream", options }),
          });
        },
      }),
    });
    const callOptions = { prompt: [], tools: [{ name: "t" }] };
    expect(await controller.doGenerate(callOptions)).toEqual({ delegated: "generate", options: callOptions });
    expect(await controller.doStream(callOptions)).toEqual({ delegated: "stream", options: callOptions });
    expect(seen).toEqual(["sk-a"]);
  });

  it("honors the model-override env var for the resolved provider", async () => {
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a", VENDO_DEV_ANTHROPIC_MODEL: "claude-opus-4-8" },
      importModule: async () => ({
        createAnthropic: () => (modelId: string) => ({
          specificationVersion: "v3",
          provider: "anthropic",
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({ modelId }),
          doStream: async () => ({ modelId }),
        }),
      }),
    });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ modelId: "claude-opus-4-8" });
  });
});

// The vendo-shipped provider fallback (unified try surface follow-up): the
// umbrella ships @ai-sdk/anthropic as a real dependency, so a key alone lights
// up live chat under `npx vendo try` on repos with no @ai-sdk install. These
// tests exercise the REAL resolution path (no importModule seam): host-root
// resolution against a temp fixture repo, vendo's own module context as the
// provider fallback.
describe("provider module resolution (host first, vendo's copy as fallback)", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vendo-model-fallback-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    return root;
  }

  /** Vitest exports NODE_PATH pointing at the workspace's .pnpm store, which
   *  makes EVERY bare specifier resolve from any root. Real hosts don't run
   *  with that; drop it (Module._initPaths re-reads NODE_PATH — mutating the
   *  Module.globalPaths snapshot does nothing) so host-root resolution
   *  honestly fails for the fixture, the way the 0.4.x E2E cert proved it
   *  does in the field. */
  async function withoutGlobalPaths<Result>(run: () => Promise<Result>): Promise<Result> {
    const initPaths = (Module as unknown as { _initPaths: () => void })._initPaths;
    const saved = process.env["NODE_PATH"];
    delete process.env["NODE_PATH"];
    initPaths();
    try {
      return await run();
    } finally {
      process.env["NODE_PATH"] = saved;
      initPaths();
    }
  }

  it("falls back to vendo's own @ai-sdk/anthropic when the host has no provider install", async () => {
    const root = await fixtureRoot();
    const controller = new DevModelController({ root, env: { ANTHROPIC_API_KEY: "sk-a" } });
    const resolution = await withoutGlobalPaths(() => controller.resolve());
    expect(resolution.mode).toBe("delegate");
    if (resolution.mode !== "delegate") return;
    // The model is the real vendo-shipped provider's, constructed and callable.
    expect(resolution.model.provider).toContain("anthropic");
    expect(resolution.model.modelId).toBe("claude-sonnet-4-6");
  });

  it("prefers the host's own provider install over vendo's copy", async () => {
    const root = await fixtureRoot();
    // A fake host install: their version, their module instance, must win —
    // dual copies of one provider are the ai-SDK dual-package hazard.
    const moduleDir = join(root, "node_modules", "@ai-sdk", "anthropic");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(
      join(moduleDir, "package.json"),
      JSON.stringify({ name: "@ai-sdk/anthropic", version: "0.0.0", type: "module", main: "index.js" }),
    );
    await writeFile(
      join(moduleDir, "index.js"),
      `export function createAnthropic() {
        return (modelId) => ({
          specificationVersion: "v3",
          provider: "host-anthropic",
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({ from: "host" }),
          doStream: async () => ({ from: "host" }),
        });
      }
      `,
    );
    const controller = new DevModelController({ root, env: { ANTHROPIC_API_KEY: "sk-a" } });
    expect(await controller.doGenerate({ prompt: [] })).toEqual({ from: "host" });
  });

  it("scopes the fallback to @ai-sdk/* provider modules only", async () => {
    const root = await fixtureRoot();
    await withoutGlobalPaths(async () => {
      // zod resolves from vendo's own context, but it is not a provider
      // module: arbitrary specifiers keep strict host-root resolution.
      await expect(importHostModule(root, "zod")).rejects.toThrow();
      // The provider module DOES fall back from the same fixture root.
      const loaded = await importHostModule(root, "@ai-sdk/anthropic");
      expect(typeof loaded["createAnthropic"]).toBe("function");
    });
  });
});
