import type {PrismaClient} from '@prisma/client';
import {executeGraph as executeKernel,type GraphKernelInput} from '@ai-qa/adapter-sdk/graph-kernel';
import {invokeCapability} from './capability-invoker.js';
export * from '@ai-qa/adapter-sdk/graph-kernel';
export interface GraphExecutionInput extends Omit<GraphKernelInput,'invoke'|'loadDefinition'> {
 prisma:PrismaClient;
 invoke?:typeof invokeCapability;
}
/** The worker owns all effects; the shared graph kernel has no database or network dispatcher. */
export function executeGraph(args:GraphExecutionInput){
 return executeKernel({...args,
  loadDefinition:ref=>args.prisma.v2WorkflowDefinition.findFirst({where:{id:ref.definitionId,version:ref.version,projectId:args.projectId}}),
  invoke:request=>(args.invoke??invokeCapability)({...request,prisma:args.prisma}),
 });
}
