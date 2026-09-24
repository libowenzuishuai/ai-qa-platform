
    import { runDraftSessionLoop } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/session-loop.ts";
    import { registerBuiltinSamples } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/samples.ts";
    import { PrismaClient } from "@prisma/client";
    registerBuiltinSamples();
    const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_test_v2loop_muf168cn_tn81?schema=public" } } });
    const r = await runDraftSessionLoop({
      prisma, sessionId: "cmuf169bi000f0aun6j3uq8sk", baseUrl: "http://127.0.0.1:25919",
      planner: "script", killAt: "after_write_before_receipt", killMarkerFile: "/var/folders/b9/gc3gz63s349_97cz8qqzdy0r0000gn/T/loop-kill-54da03ea-fb04-4aee-b562-b6755d61ca8a.marker",
    }).catch((e) => { console.error("LOOP-ERR", e?.message, e?.code); process.exit(1); });
    console.error("LOOP-RESULT", JSON.stringify(r));
  