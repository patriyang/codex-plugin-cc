/** @typedef {import("./app-server-protocol").AppServerRequestParams<"turn/start">} TurnStartParams */
import { runAppServerTurn } from "./codex.mjs";

/** @param {TurnStartParams} params */
function assertTurnStartParams(params) {}

assertTurnStartParams({ threadId: "thread", input: [], effort: "max" });
assertTurnStartParams({ threadId: "thread", input: [], effort: "ultra" });
runAppServerTurn("/tmp", { effort: "max" });
runAppServerTurn("/tmp", { effort: "ultra" });

// @ts-expect-error Unsupported reasoning efforts must fail checked-JS compilation.
runAppServerTurn("/tmp", { effort: "insane" });

// @ts-expect-error Unsupported reasoning efforts must fail checked-JS compilation.
assertTurnStartParams({ threadId: "thread", input: [], effort: "insane" });
