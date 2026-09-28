import {it,expect} from 'vitest';
import {BrowserAgentTask,BrowserAgentInput,BrowserAgentOutput} from '../src/index.js';
const task={goal:'test',roles:[{id:'author',startUrl:'http://localhost'}],operations:[{id:'save',role:'author',kind:'click',target:'保存'}]};
it('browser authority rejects duplicate roles, missing dependencies, cycles and undeclared roles',()=>{
 expect(BrowserAgentTask.safeParse(task).success).toBe(true);
 expect(BrowserAgentTask.safeParse({...task,roles:[...task.roles,...task.roles]}).success).toBe(false);
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],role:'admin'}]}).success).toBe(false);
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],after:['missing']}]}).success).toBe(false);
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],after:['other']},{...task.operations[0],id:'other',after:['save']}]}).success).toBe(false);
});
it('parameters and visual actions are restricted; model cannot append executable fields',()=>{
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],kind:'fill'}]}).success).toBe(false);
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],kind:'fill',value:'x',visual:true}]}).success).toBe(false);
 expect(BrowserAgentOutput.safeParse({observationId:'now',actionId:'save',elementRef:'ref',status:'act',rationale:'x',eval:'process.exit()'}).success).toBe(false);
 expect(BrowserAgentOutput.safeParse({observationId:'now',actionId:'save',elementRef:'ref',status:'act',rationale:'x',point:{x:9999,y:0}}).success).toBe(false);
});
it('bounded observations cannot silently accept unversioned prompts or arbitrary image URLs',()=>{
 expect(BrowserAgentInput.safeParse({strategy:'semantic-v1',promptVersion:'latest',goal:'x',observationId:'now',elements:[],operations:[],completed:[]}).success).toBe(false);
 expect(BrowserAgentInput.safeParse({promptVersion:'browser-agent-v1',goal:'x',observationId:'now',elements:[],operations:[],completed:[],images:[{role:'author',tab:0,imageStorageKey:'path',checksum:'bad'}]}).success).toBe(false);
});

it('native dialog policy is exact and limited to its approved click',()=>{
 const dialog={type:'confirm',message:'Save?',action:'accept'};
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],dialog}]}).success).toBe(true);
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],kind:'reload',dialog}]}).success).toBe(false);
 expect(BrowserAgentTask.safeParse({...task,operations:[{...task.operations[0],dialog:{...dialog,promptText:'x'}}]}).success).toBe(false);
});
