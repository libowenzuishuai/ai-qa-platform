import {defineConfig} from 'vitest/config';
// Each integration file provisions its own database. Bound concurrent migrations on shared CI hosts.
export default defineConfig({test:{include:['test/**/*.test.ts'],environment:'node',maxWorkers:2,hookTimeout:30000}});
