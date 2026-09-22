import {cancelGithubWork} from './github-lifecycle.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Prisma,PrismaClient} from '@prisma/client';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {GitHubConnectRequest,GitHubCiConfig} from '@ai-qa/contracts';
import {requireAuth,requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';
import {GitHubApp,githubConfig,hash} from './github-app.js';
import {freezeExecutableTemplate} from './template-runtime.js';
export function registerGithubRoutes(app:FastifyInstance,db:PrismaClient,providerFactory=()=>new GitHubApp(githubConfig())){
 const id=(req:FastifyRequest)=>(req.params as {id:string}).id;
 app.get('/api/projects/:id/github',async req=>{
  const projectId=id(req);await requireProjectAccess(db,req,projectId);let configured=true;try{providerFactory();}catch{configured=false;}
  const integrations=await db.githubIntegration.findMany({where:{projectId},orderBy:{createdAt:'desc'}});
  const page=z.coerce.number().int().min(1).max(100000).default(1).parse((req.query as any).page);
  return {configured,integrations,deliveries:await db.githubDelivery.findMany({where:{projectId},select:{id:true,event:true,status:true,detail:true,workflowId:true,remoteCheckId:true,createdAt:true},orderBy:{createdAt:'desc'},skip:(page-1)*30,take:30}),total:await db.githubDelivery.count({where:{projectId}}),page};
 });
 app.post('/api/projects/:id/github/connect',async req=>{
  const projectId=id(req);await requireProjectAccess(db,req,projectId,'ADMIN');const {repository}=GitHubConnectRequest.parse(req.body),provider=providerFactory(),state=randomBytes(32).toString('hex');
  await db.githubAuthState.create({data:{hash:hash(state),projectId,userId:requireAuth(req).userId,repository,expiresAt:new Date(Date.now()+600000)}});
  const url=new URL('https://github.com/login/oauth/authorize');url.searchParams.set('client_id',provider.config.clientId);url.searchParams.set('redirect_uri',provider.config.callbackUrl);url.searchParams.set('state',state);return {authorizationUrl:url.href};
 });
 app.post('/api/github/callback',{logLevel:'silent'},async req=>{
  const actor=requireAuth(req),body=z.object({code:z.string().min(1).max(2000),state:z.string().length(64)}).strict().parse(req.body);
  const state=await db.githubAuthState.findUnique({where:{hash:hash(body.state)}});
  if(!state||state.userId!==actor.userId||state.consumedAt||state.expiresAt<=new Date())throw new ApiError('FORBIDDEN','授权状态已失效或不属于当前用户');
  await requireProjectAccess(db,req,state.projectId,'ADMIN');
  const claimed=await db.githubAuthState.updateMany({where:{hash:state.hash,consumedAt:null,expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});if(!claimed.count)throw new ApiError('CONFLICT','授权回调已使用');
  const identity=await providerFactory().authorizedRepository(body.code,state.repository);
  return db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${state.projectId} FOR UPDATE`;
   const integration=await tx.githubIntegration.upsert({where:{projectId_repositoryId:{projectId:state.projectId,repositoryId:identity.repositoryId}},create:{projectId:state.projectId,...identity,configuredBy:actor.userId},update:{...identity,status:'ACTIVE',revision:{increment:1},configuredBy:actor.userId,ci:{enabled:false}}});
   await tx.auditEvent.create({data:{actorId:actor.userId,action:'github.connect',entityType:'GithubIntegration',entityId:integration.id,metadata:{repository:identity.repository,projectId:state.projectId}}});return {projectId:state.projectId,integration};
  });
 });
 app.put('/api/github/:id/ci',async req=>{
  const integration=await db.githubIntegration.findUnique({where:{id:id(req)}});if(!integration)throw new ApiError('NOT_FOUND','连接不存在');await requireProjectAccess(db,req,integration.projectId,'ADMIN');
  const ci=GitHubCiConfig.parse(req.body);
  const template=await db.workflowTemplate.findFirst({where:{id:ci.templateId,projectId:integration.projectId,status:'PUBLISHED'}});if(!template)throw new ApiError('VALIDATION_ERROR','请选择已发布模板');
  const compiled=await freezeExecutableTemplate(db,integration.projectId,template.nodes);
  if(compiled.nodes.length!==1||compiled.nodes[0]!.capabilityKey!=='code-check')throw new ApiError('UNSUPPORTED','CI 首版仅运行已发布的单步骤工程体检模板；业务验收仍需人工批准环境和执行范围');
  return db.$transaction(async tx=>{
   const saved=await tx.githubIntegration.updateMany({where:{id:integration.id,revision:integration.revision,status:'ACTIVE'},data:{ci:ci as never,revision:{increment:1}}});if(!saved.count)throw new ApiError('CONFLICT','连接已变化或撤销');
   await cancelGithubWork(tx,integration,'CI 配置已变化');
   await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,action:'github.ci.configure',entityType:'GithubIntegration',entityId:integration.id,metadata:ci as never}});return {ok:true};
  });
 });
 async function revokeIn(tx:Prisma.TransactionClient,installationId:string,repositoryIds:string[]|null,actor:string,projectId?:string){
  const affected=await tx.githubIntegration.findMany({where:{installationId,...(projectId?{projectId}:{}),...(repositoryIds?{repositoryId:{in:repositoryIds}}:{})}});
  for(const integration of affected){
   await tx.githubIntegration.update({where:{id:integration.id},data:{status:'REVOKED',revision:{increment:1}}});
   await cancelGithubWork(tx,integration,'GitHub 授权已撤销',true);
   await tx.auditEvent.create({data:{actorId:actor,action:'github.revoke',entityType:'GithubIntegration',entityId:integration.id}});
  }
  return {ok:true};
 }
 const revoke=(installationId:string,ids:string[]|null,actor:string,projectId?:string)=>db.$transaction(tx=>revokeIn(tx,installationId,ids,actor,projectId));
 app.post('/api/github/:id/revoke',async req=>{
  const integration=await db.githubIntegration.findUnique({where:{id:id(req)}});if(!integration)throw new ApiError('NOT_FOUND','连接不存在');await requireProjectAccess(db,req,integration.projectId,'ADMIN');
  // Local unlink affects only this project; installation-wide revoke is provider-signed below.
  return revoke(integration.installationId,[integration.repositoryId],requireAuth(req).userId,integration.projectId);
 });
 app.post('/api/github/deliveries/:id/retry',async req=>{
  const delivery=await db.githubDelivery.findUnique({where:{id:id(req)}});if(!delivery?.projectId)throw new ApiError('NOT_FOUND','事件不存在');await requireProjectAccess(db,req,delivery.projectId,'ADMIN');
  if(!['FAILED','WRITE_UNCERTAIN'].includes(delivery.status))throw new ApiError('CONFLICT','只有失败或结果不明的回传可重试');
  await db.githubDelivery.updateMany({where:{id:delivery.id,status:delivery.status},data:{status:'QUEUED',leaseExpiresAt:null}});return {ok:true};
 });
 app.register(async scoped=>{
  scoped.removeContentTypeParser('application/json');scoped.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  scoped.post('/api/github/webhook',{bodyLimit:1024*1024,logLevel:'silent'},async(req,reply)=>{
   const raw=req.body as Buffer,provider=providerFactory();if(!Buffer.isBuffer(raw)||!provider.verifySignature(raw,req.headers['x-hub-signature-256']))throw new ApiError('FORBIDDEN','GitHub 签名无效');
   const delivery=z.string().min(1).max(200).parse(req.headers['x-github-delivery']),event=z.string().max(100).parse(req.headers['x-github-event']);
   let payload:any;try{payload=JSON.parse(raw.toString());}catch{throw new ApiError('VALIDATION_ERROR','事件正文不是 JSON');}
   const installationId=String(payload.installation?.id??'');
   const userRevoke=event==='github_app_authorization'&&payload.action==='revoked';
   const installRevoke=event==='installation'&&['deleted','suspend'].includes(payload.action);
   const removed=event==='installation_repositories'&&payload.action==='removed';
   if(userRevoke||installRevoke||removed)return db.$transaction(async tx=>{
    const key='control:'+delivery;await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const old=await tx.githubDelivery.findUnique({where:{deliveryId:key}});
    if(old){if(old.payloadHash!==hash(raw))throw new ApiError('CONFLICT','重复控制事件正文不一致');return {ok:true};}
    if(userRevoke){
     const userId=String(payload.sender?.id??'');if(!/^\d+$/.test(userId))throw new ApiError('VALIDATION_ERROR','缺少用户身份');
     const affected=await tx.githubIntegration.findMany({where:{githubUserId:userId}});
     for(const i of affected)await revokeIn(tx,i.installationId,[i.repositoryId],'github:user-revoked',i.projectId);
    }else{
     if(!/^\d+$/.test(installationId))throw new ApiError('VALIDATION_ERROR','缺少安装身份');
     const ids=removed?z.array(z.object({id:z.number().int().positive()})).max(10000).parse(payload.repositories_removed).map(r=>String(r.id)):null;
     await revokeIn(tx,installationId,ids,'github:webhook');
    }
    await tx.githubDelivery.create({data:{deliveryId:key,payloadHash:hash(raw),event,payload:{action:payload.action},status:'COMPLETED',detail:'授权变更已应用'}});return {ok:true};
   });
   if(!/^\d+$/.test(installationId))throw new ApiError('VALIDATION_ERROR','缺少安装身份');
   const repoId=String(payload.repository?.id??''),integrations=await db.githubIntegration.findMany({where:{installationId,repositoryId:repoId,status:'ACTIVE'}});
   for(const integration of integrations){
    const ci=GitHubCiConfig.safeParse(integration.ci),p=payload.pull_request;
    const fork=event==='pull_request'&&String(p?.head?.repo?.id)!==repoId;
    const ignored=!ci.success||!ci.data.enabled||!['push','pull_request'].includes(event)||fork||event==='push'&&(payload.deleted||payload.ref!=='refs/heads/'+ci.data.branch)||event==='pull_request'&&(!['opened','reopened','synchronize'].includes(payload.action)||p?.base?.ref!==ci.data.branch);
    const clean={repositoryId:repoId,installationId,ref:payload.ref??null,sha:event==='push'?payload.after:p?.head?.sha,number:payload.number??null,action:payload.action??null};
    await db.$transaction(async tx=>{
     const key=delivery+':'+integration.id,prior=await tx.githubDelivery.findUnique({where:{deliveryId:key}});if(prior){if(prior.payloadHash!==hash(raw))throw new ApiError('CONFLICT','重复 delivery 的正文不一致');return;}
     // Advisory transaction lock covers simultaneous provider redelivery before the unique insert.
     await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
     const duplicate=await tx.githubDelivery.findUnique({where:{deliveryId:key}});if(duplicate){if(duplicate.payloadHash!==hash(raw))throw new ApiError('CONFLICT','重复事件正文不一致');return;}
     await tx.githubDelivery.create({data:{deliveryId:key,payloadHash:hash(raw),integrationId:integration.id,integrationRevision:integration.revision,projectId:integration.projectId,event,payload:clean,status:ignored?'IGNORED':'QUEUED',detail:ignored?'事件不在启用范围、来自 fork 或已删除分支':null}});
    });
   }
   return reply.code(202).send({received:true});
  });
 });
}
