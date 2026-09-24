
    import { runDraftSessionLoop } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/session-loop.ts";
    import { PrismaClient } from "@prisma/client";
    const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_test_v2loop_muf14avv_sdpa?schema=public" } } });
    const r = await runDraftSessionLoop({
      prisma, sessionId: "cmuf14bso000f0ak6ajiyvbml", baseUrl: "http://127.0.0.1:31831",
      planner: "script", killAt: "after_write_before_receipt", killMarkerFile: "/var/folders/b9/gc3gz63s349_97cz8qqzdy0r0000gn/T/loop-kill-38692ddc-e60b-48ab-9b6a-e7b265df79f5.marker",
    }).catch((e) => { console.error("LOOP-ERR", e?.message, e?.code); process.exit(1); });
    console.error("LOOP-RESULT", JSON.stringify(r));
  