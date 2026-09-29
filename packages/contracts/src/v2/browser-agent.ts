import {z} from 'zod';
const key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const BrowserExploration=z.object({
 roles:z.array(key).min(1).max(8),
 kinds:z.array(z.enum(['click','fill','select','reload','wait'])).min(1).max(5),
 values:z.array(z.object({id:key,value:z.string().max(4000)}).strict()).max(50),
}).strict();
/** Approved operations are the authority boundary. The model only selects an operation and a fresh reference. */
export const BrowserOperation=z.object({
 id:key,role:key,kind:z.enum(['click','fill','select','navigate','reload','switch_tab','wait','hover','check','uncheck','press','upload','download','scroll']),
 target:z.string().min(1).max(200),value:z.string().max(4000).optional(),
 after:z.array(key).max(50).default([]),maxUses:z.number().int().min(1).max(5).default(1),
 download:z.object({filename:z.string().min(1).max(200),maxBytes:z.number().int().min(1).max(8388608)}).strict().optional(),
 visual:z.boolean().default(false),
 dialog:z.object({type:z.enum(['alert','confirm','prompt']),message:z.string().min(1).max(1000),action:z.enum(['accept','dismiss']),promptText:z.string().max(1000).optional()}).strict().optional(),
}).strict();
export const BrowserAgentTask=z.object({
 goal:z.string().min(1).max(4000),
 roles:z.array(z.object({id:key,startUrl:z.string().url(),authenticate:z.boolean().default(false),
  writes:z.array(z.object({method:z.enum(['POST','PUT','PATCH','DELETE']),origin:z.string().url().optional(),pathname:z.string().startsWith('/').max(500)}).strict()).max(50).default([]),
 }).strict()).min(1).max(8),
 operations:z.array(BrowserOperation).max(100),
 exploration:BrowserExploration.optional(),
 maxRounds:z.number().int().min(1).max(100).default(30),
 strategy:z.enum(['semantic-v1','model-v1']).default('semantic-v1'),
}).strict().superRefine((task,ctx)=>{
 if(!task.operations.length&&!task.exploration)ctx.addIssue({code:'custom',message:'需要操作目录或探索范围'});
 if(task.exploration&&(task.strategy!=='model-v1'||task.exploration.roles.some(r=>!task.roles.some(x=>x.id===r))||new Set(task.exploration.values.map(v=>v.id)).size!==task.exploration.values.length))ctx.addIssue({code:'custom',message:'探索需模型规划、已声明角色和唯一批准数据编号'});
 const ids=new Set(task.operations.map(x=>x.id)),roles=new Set(task.roles.map(x=>x.id));
 if(ids.size!==task.operations.length||roles.size!==task.roles.length)ctx.addIssue({code:'custom',message:'角色或操作 ID 重复'});
 for(const op of task.operations){
  if(op.dialog&&(op.kind!=='click'||op.dialog.promptText!==undefined&&(op.dialog.type!=='prompt'||op.dialog.action!=='accept')))ctx.addIssue({code:'custom',message:'弹窗策略只能绑定点击；输入值只用于接受输入弹窗'});
  if(op.visual&&op.kind!=='click')ctx.addIssue({code:'custom',message:'视觉坐标仅允许批准的点击动作'});
  if(!roles.has(op.role)||op.after.some(x=>!ids.has(x)||x===op.id))ctx.addIssue({code:'custom',message:'操作角色或依赖无效'});
  if(op.kind==='download'&&!op.download||op.download&&op.kind!=='download')ctx.addIssue({code:'custom',message:'下载须声明文件名和大小上限'});
  if(op.kind==='press'&&!['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].includes(op.value??''))ctx.addIssue({code:'custom',message:'按键不在受限集合'});
  if(op.kind==='scroll'&&!['up','down'].includes(op.value??''))ctx.addIssue({code:'custom',message:'滚动方向无效'});
  if(['fill','select','navigate','upload'].includes(op.kind)&&op.value===undefined)ctx.addIssue({code:'custom',message:'操作缺少批准参数'});
 }
 const visited=new Set<string>();for(let n=0;n<task.operations.length;n++)for(const op of task.operations)if(op.after.every(x=>visited.has(x)))visited.add(op.id);
 if(visited.size!==ids.size)ctx.addIssue({code:'custom',message:'操作依赖循环'});
});
export type BrowserAgentTask=z.infer<typeof BrowserAgentTask>;
export const BrowserElement=z.object({ref:z.string(),role:key,tab:z.number().int().min(0),frame:z.number().int().min(0),tag:z.string(),name:z.string().max(300),type:z.string(),enabled:z.boolean(),box:z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).nullable()}).strict();
export type BrowserElement=z.infer<typeof BrowserElement>;
export const BrowserAgentInput=z.object({
 modelPins:z.object({decision:z.object({provider:z.enum(['moonshot','openai-compatible']),model:z.string().min(1).max(200)}).strict(),vision:z.object({provider:z.enum(['moonshot','openai-compatible']),model:z.string().min(1).max(200)}).strict().optional()}).strict().optional(),
 strategy:z.enum(['semantic-v1','model-v1']).default('semantic-v1'),promptVersion:z.literal('browser-agent-v1'),goal:z.string().max(4000),
 images:z.array(z.object({role:key,tab:z.number().int().min(0),imageStorageKey:z.string().max(1000),checksum:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(8).default([]),hints:z.array(z.object({memoryId:z.string(),text:z.string().max(1500)}).strict()).max(3).default([]),observationId:z.string(),elements:z.array(BrowserElement).max(800),
 exploration:BrowserExploration.optional(),
 pages:z.array(z.object({role:key,url:z.string(),title:z.string().max(500),text:z.string().max(8000)}).strict()).max(8).optional(),
 history:z.array(z.object({id:key,role:key,kind:z.string(),target:z.string(),status:z.literal("SUCCEEDED")}).strict()).max(100).optional(),
 operations:z.array(BrowserOperation).max(100),completed:z.array(key).max(100),
}).strict();
export type BrowserAgentInput=z.infer<typeof BrowserAgentInput>;
export const BrowserAgentOutput=z.object({
 observationId:z.string(),actionId:key.nullable(),elementRef:z.string().nullable(),
 proposed:z.object({role:key,kind:z.enum(["click","fill","select","reload","wait"]),valueRef:key.optional()}).strict().optional(),
 point:z.object({x:z.number().min(0).max(1280),y:z.number().min(0).max(800)}).strict().nullable().default(null),status:z.enum(['act','done','blocked']),rationale:z.string().min(1).max(1000),
}).strict();
export type BrowserAgentOutput=z.infer<typeof BrowserAgentOutput>;
