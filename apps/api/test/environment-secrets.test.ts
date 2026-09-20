import { it, expect } from 'vitest';
import { EnvironmentRuntime } from '@ai-qa/contracts';
import { projectSecretPrefix, validateSecretNamespace } from '../src/environment-secrets.js';
it('project admins can only select credentials from their project namespace',()=>{
 const runtime=EnvironmentRuntime.parse({secretRefs:{visitor:{passwordEnv:projectSecretPrefix('p1')+'PASSWORD'}}});
 expect(()=>validateSecretNamespace('p1',runtime)).not.toThrow();
 expect(()=>validateSecretNamespace('p2',runtime)).toThrow('当前项目');
});
