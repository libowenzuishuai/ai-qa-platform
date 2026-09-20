import type { PrismaClient } from '@prisma/client';
export async function reconcileCodeChecks(prisma:PrismaClient){
  await prisma.codeCheck.updateMany({where:{status:'CANCEL_REQUESTED',OR:[{leaseExpiresAt:{lt:new Date()}},{deadlineAt:{lt:new Date()}}]},data:{status:'CANCELLED',verdict:'INCOMPLETE',leaseToken:null,result:{reason:'取消后运行器未返回；执行已停止或租约过期，未验证结果'}}});
  await prisma.codeCheck.updateMany({where:{status:'RUNNING',OR:[{leaseExpiresAt:{lt:new Date()}},{deadlineAt:{lt:new Date()}}]},data:{status:'ERROR',verdict:'INCOMPLETE',leaseToken:null,result:{reason:'运行器失联或时间预算耗尽；未自动重放命令'}}});
}
