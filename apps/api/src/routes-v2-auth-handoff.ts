import type {FastifyInstance} from 'fastify';
import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {requireAuth,requireProjectAccess} from './auth.js';
import {ApiError} from './errors.js';
export function registerV2AuthHandoffRoutes(app:FastifyInstance,prisma:PrismaClient){
 app.post('/api/v2/sessions/:id/auth-complete',async req=>{
  const {id}=req.params as {id:string},body=z.object({nonce:z.string().uuid()}).strict().parse(req.body);
  const session=await prisma.v2ExecutionSession.findUnique({where:{id}});if(!session)throw new ApiError('NOT_FOUND','运行不存在');
  await requireProjectAccess(prisma,req,session.projectId,'LEAD');
  return prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "V2ExecutionSession" WHERE id=${id} FOR UPDATE`;
   const fresh=await tx.v2ExecutionSession.findUniqueOrThrow({where:{id}}),auth=(fresh.checkpoint as {auth?:{nonce:string;deadline:string;state:string}}).auth;
   if(fresh.status!=='WAITING_AUTH'||!fresh.leaseExpiresAt||fresh.leaseExpiresAt<=new Date()||!auth||auth.nonce!==body.nonce||auth.state!=='waiting'||new Date(auth.deadline)<=new Date())throw new ApiError('CONFLICT','人工认证窗口已失效，不能恢复丢失的浏览器');
   const prior=await tx.auditEvent.findFirst({where:{entityType:'V2ExecutionSession',entityId:id,action:'v2.auth.complete',metadata:{path:['nonce'],equals:body.nonce}}});
   if(!prior)await tx.auditEvent.create({data:{actorId:requireAuth(req).userId,entityType:'V2ExecutionSession',entityId:id,action:'v2.auth.complete',metadata:{nonce:body.nonce}}});
   return {accepted:true,verified:false,message:'运行器仍需重新验证登录成功标识；人工确认不等于认证通过'};
  });
 });
}
