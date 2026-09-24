
    import { runDraftSessionLoop } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/session-loop.ts";
    import { registerBuiltinSamples } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/samples.ts";
    import { PrismaClient } from "@prisma/client";
    registerBuiltinSamples();
    const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_test_v2loop_muf14kss_0jwh?schema=public" } } });
    const r = await runDraftSessionLoop({
      prisma, sessionId: "cmuf14lpv000f0amgkqej1uiv", baseUrl: "http://127.0.0.1:23983",
      planner: "script", killAt: "after_write_before_receipt", killMarkerFile: "/var/folders/b9/gc3gz63s349_97cz8qqzdy0r0000gn/T/loop-kill-5965ce99-3338-4a3c-a8ba-77859e3c8725.marker",
    }).catch((e) => { console.error("LOOP-ERR", e?.message, e?.code); process.exit(1); });
    console.error("LOOP-RESULT", JSON.stringify(r));
  