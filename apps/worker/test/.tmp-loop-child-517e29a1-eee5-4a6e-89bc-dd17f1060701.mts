
    import { runDraftSessionLoop } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/session-loop.ts";
    import { PrismaClient } from "@prisma/client";
    const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_test_v2loop_muf140gj_ivqr?schema=public" } } });
    await runDraftSessionLoop({
      prisma, sessionId: "cmuf141dk000f0ahpo4hpqprn", baseUrl: "http://127.0.0.1:24445",
      planner: "script", killAt: "after_write_before_receipt", killMarkerFile: "/var/folders/b9/gc3gz63s349_97cz8qqzdy0r0000gn/T/loop-kill-e9c3a63b-6774-4a4f-91cb-717f22c4f282.marker",
    }).catch((e) => { console.error("LOOP-ERR", e); process.exit(1); });
    console.error("LOOP-RETURNED-EARLY");
  