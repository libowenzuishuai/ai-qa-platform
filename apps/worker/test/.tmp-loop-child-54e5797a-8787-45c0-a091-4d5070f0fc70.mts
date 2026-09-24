
    import { runDraftSessionLoop } from "/Users/libowen/Documents/Codex/2026-09-15/we/outputs/ai-qa-development-kit/apps/worker/src/v2/session-loop.ts";
    import { PrismaClient } from "@prisma/client";
    const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_test_v2loop_muf13hfw_lp9s?schema=public" } } });
    runDraftSessionLoop({
      prisma, sessionId: "cmuf13ibw000f0adx80ugy7jr", baseUrl: "http://127.0.0.1:31778",
      planner: "script", killAt: "after_write_before_receipt", killMarkerFile: "/var/folders/b9/gc3gz63s349_97cz8qqzdy0r0000gn/T/loop-kill-4c702b6b-a2a6-4552-9974-cadbe1419f0b.marker",
    }).catch((e) => { console.error(e); process.exit(1); });
  