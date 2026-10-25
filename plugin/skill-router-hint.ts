/**
 * opencode plugin: skill-router context hint («secretary»), spec §7.
 *
 * Before every model dispatch (hook `context`, i.e. the agent loop including
 * tool-driven continuations) appends ONE text part with a `<skill_hint>` block
 * to `system`: at most 2 skills, at most 1000 chars, formation ≤150 ms.
 * The hint is text for the model — it never loads skills: no `skill` call, no
 * other tools, no file writes, no skill-gate events (R1, R4).
 *
 * Loading (see README «Plugin»): a path entry in the `plugins` array of
 * opencode.json(c), or auto-discovery of `.opencode/plugins/` /
 * `~/.config/opencode/plugins/`. Requires the repo layout (`plugin/` next to
 * `core/`), because `./hint.mjs` imports `../core/*`. Restart opencode after
 * changing it.
 *
 * Types are local and structural on purpose: `@opencode/plugin` is NOT
 * installed in this repository (the product's only dependency is minisearch),
 * and `Plugin.define()` is an identity helper — the loader requires a default
 * object with `id` and `setup` (opencode @opencode/plugin 2.0.6:
 * dist/promise/plugin.d.ts:55-59, dist/promise/plugin.js `define` returns its
 * argument; observed behaviour documented in README). The hook signature this
 * file relies on: dist/promise/session.d.ts:143-145 (`SessionDomain.hook`),
 * event fields at dist/promise/session.d.ts:22-35.
 *
 * Fail-open: everything inside the hook body is try/caught in ./hint.mjs;
 * if the hook cannot be registered, opencode logs a plugin-load error and the
 * session continues without the hint.
 */
import { createContextHook } from "./hint.mjs";

interface Registration {
  dispose(): Promise<void>;
}

/** Text part of the assembled `system` prompt (SystemPart, type "text"). */
interface SystemPart {
  readonly type: "text";
  readonly text: string;
}

interface MessageLike {
  readonly role?: string;
  readonly content?: unknown;
}

/** Structural subset of the `context` hook event the hint reads (fields per dist/promise/session.d.ts:22-35). */
interface SessionContextEvent {
  readonly agent?: string;
  system: SystemPart[];
  messages?: MessageLike[];
}

interface PluginSessionDomain {
  hook(
    name: "context",
    callback: (event: SessionContextEvent) => Promise<void> | void,
  ): Promise<Registration>;
}

interface PluginContextLike {
  session: PluginSessionDomain;
}

interface PluginModule {
  readonly id: string;
  setup(context: PluginContextLike): Promise<void> | void;
}

const plugin: PluginModule = {
  id: "skill-router-hint",
  async setup(ctx) {
    const onContext = createContextHook();
    await ctx.session.hook("context", (event) => {
      onContext(event);
    });
  },
};

export default plugin;
