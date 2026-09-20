import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
afterEach(() => vi.unstubAllEnvs());
it('defaults to Python; reference requires explicit opt-in and unknown backend fails', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://unused');
  vi.stubEnv('AIQA_INTELLIGENCE_BACKEND', undefined);
  expect(loadConfig().intelligenceBackend).toBe('python');
  vi.stubEnv('AIQA_INTELLIGENCE_BACKEND', 'reference');
  expect(loadConfig().intelligenceBackend).toBe('reference');
  vi.stubEnv('AIQA_INTELLIGENCE_BACKEND', 'typo');
  expect(() => loadConfig()).toThrow();
});
