/**
 * opencode directory entry point: a `plugins` entry pointing at a directory
 * must resolve to its `index`/`server` module — this file is that module.
 * It only reproduces the `{id, setup}` assembly of ./skill-mcp-hint.ts
 * (no `.ts` imports a `.ts`); all hint logic stays in ./hint.mjs (block
 * format, 150 ms budget, fail-open — unchanged here).
 * Local structural types on purpose: the repo does not depend on
 * `@opencode/plugin` (details in the header of ./skill-mcp-hint.ts).
 */
import { createContextHook, type HintContextEvent } from "./hint.mjs";

interface Registration {
  dispose(): Promise<void>;
}

interface PluginSessionDomain {
  hook(name: "context", callback: (event: HintContextEvent) => Promise<void> | void): Promise<Registration>;
}

interface PluginContextLike {
  session: PluginSessionDomain;
}

interface PluginModule {
  readonly id: string;
  setup(context: PluginContextLike): Promise<void> | void;
}

const plugin: PluginModule = {
  id: "skill-mcp-hint",
  async setup(ctx) {
    const onContext = createContextHook();
    await ctx.session.hook("context", (event) => {
      onContext(event);
    });
  },
};

export default plugin;
