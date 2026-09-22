import {createHash,createHmac,createSign,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {PrismaClient,Prisma} from '@prisma/client';
import {ApiError} from './errors.js';
export const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export type GitHubConfig={appId:string;clientId:string;clientSecret:string;privateKey:string;webhookSecret:string;callbackUrl:string};
export function githubConfig():GitHubConfig{
 const names=['AIQA_GITHUB_APP_ID','AIQA_GITHUB_CLIENT_ID','AIQA_GITHUB_CLIENT_SECRET','AIQA_GITHUB_PRIVATE_KEY_FILE','AIQA_GITHUB_WEBHOOK_SECRET','AIQA_GITHUB_CALLBACK_URL'];
 if(names.some(k=>!process.env[k]))throw new ApiError('DEPENDENCY_UNAVAILABLE','GitHub App 尚未配置');
 try{return {appId:process.env[names[0]!]!,clientId:process.env[names[1]!]!,clientSecret:process.env[names[2]!]!,privateKey:readFileSync(process.env[names[3]!]!,'utf8'),webhookSecret:process.env[names[4]!]!,callbackUrl:process.env[names[5]!]!};}catch{throw new ApiError('DEPENDENCY_UNAVAILABLE','GitHub App 配置不可用');}
}
export class GitHubApp {
 constructor(readonly config:GitHubConfig,readonly transport:typeof fetch=fetch){}
 jwt(){const now=Math.floor(Date.now()/1000),encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iat:now-60,exp:now+540,iss:this.config.appId});const signature=createSign('RSA-SHA256').update(unsigned).sign(this.config.privateKey,'base64url');return unsigned+'.'+signature;}
 async json(path:string,token:string,method='GET',body?:unknown,oauth=false){
  const origin=oauth?'https://github.com':'https://api.github.com';
  if(!path.startsWith('/')||path.startsWith('//'))throw new ApiError('VALIDATION_ERROR','GitHub 请求路径无效');
  let response:Response;
  try{response=await this.transport(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{accept:oauth?'application/json':'application/vnd.github+json','content-type':'application/json','user-agent':'aiqa-github-app','x-github-api-version':'2026-03-10',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});}catch{throw new ApiError('DEPENDENCY_UNAVAILABLE','GitHub 请求不可用');}
  if(response.status===429||response.status===403&&response.headers.get('x-ratelimit-remaining')==='0')throw new ApiError('BUDGET_EXCEEDED','GitHub 限流，请稍后显式重试');
  if(response.status===401||response.status===403||response.status===404)throw new ApiError('FORBIDDEN','GitHub 安装、仓库授权或凭据已不可用');
  if(!response.ok)throw new ApiError('DEPENDENCY_UNAVAILABLE','GitHub 服务暂不可用');
  let size=0;const chunks:Uint8Array[]=[];const reader=response.body?.getReader();if(!reader)return {};
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8*1024*1024)throw new ApiError('VALIDATION_ERROR','GitHub 响应超过范围上限');chunks.push(r.value);}}finally{await reader.cancel();}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new ApiError('DEPENDENCY_UNAVAILABLE','GitHub 返回无效数据');}
 }
 async scopedToken(installationId:string,repositoryId:string,writeChecks=false){
  if(!/^\d+$/.test(installationId)||!/^\d+$/.test(repositoryId))throw new ApiError('VALIDATION_ERROR','安装身份无效');
  const data=await this.json(`/app/installations/${installationId}/access_tokens`,this.jwt(),'POST',{repository_ids:[Number(repositoryId)],permissions:{contents:'read',metadata:'read',...(writeChecks?{checks:'write'}:{})}});
  if(typeof data.token!=='string'||Date.parse(data.expires_at)<=Date.now()+30000||!Array.isArray(data.repositories)||data.repositories.length!==1||String(data.repositories[0].id)!==repositoryId)throw new ApiError('FORBIDDEN','安装令牌范围或有效期不符');
  return data.token as string;
 }
 async authorizedRepository(code:string,repository:string){
  const oauth=await this.json('/login/oauth/access_token','', 'POST',{client_id:this.config.clientId,client_secret:this.config.clientSecret,code,redirect_uri:this.config.callbackUrl},true);
  if(typeof oauth.access_token!=='string')throw new ApiError('FORBIDDEN','GitHub 用户授权失败');
  const user=await this.json('/user',oauth.access_token),repo=await this.json('/repos/'+repository,oauth.access_token);
  if(!repo.permissions?.admin||String(repo.full_name).toLowerCase()!==repository.toLowerCase())throw new ApiError('FORBIDDEN','需由仓库管理员连接准确的仓库');
  const installation=await this.json('/repos/'+repository+'/installation',this.jwt());
  if(installation.suspended_at||String(installation.app_id)!==this.config.appId)throw new ApiError('FORBIDDEN','请先为该仓库安装此 GitHub App');
  const token=await this.scopedToken(String(installation.id),String(repo.id));
  const verify=await this.json('/repos/'+repository,token);if(verify.id!==repo.id)throw new ApiError('FORBIDDEN','安装仓库身份不匹配');
  return {repositoryId:String(repo.id),repository:repo.full_name,installationId:String(installation.id),githubUserId:String(user.id)};
 }
 verifySignature(raw:Buffer,signature:unknown){
  if(typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))return false;
  const expected=createHmac('sha256',this.config.webhookSecret).update(raw).digest();return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
 }
}
export async function installationForRepository(db:PrismaClient,projectId:string,url:string){
 const name=new URL(url).pathname.slice(1).replace(/\.git\/?$/,'').replace(/\/$/,'');
 return db.githubIntegration.findFirst({where:{projectId,repository:{equals:name,mode:'insensitive'}}});
}
/** A fresh repository-scoped token is short-lived in process memory only. Revocation is checked per read. */
export function privateRepositoryFetch(db:PrismaClient,projectId:string,integrationId:string,provider:GitHubApp):typeof fetch{
 return async(input,init)=>{
  const integration=await db.githubIntegration.findFirst({where:{id:integrationId,projectId,status:'ACTIVE'}});if(!integration)throw new ApiError('FORBIDDEN','GitHub 安装已撤销');
  const url=new URL(String(input));const prefix='/repos/'+integration.repository+'/';
  if(url.origin!=='https://api.github.com'||!url.pathname.toLowerCase().startsWith(prefix.toLowerCase())||(init?.method??'GET')!=='GET')throw new ApiError('FORBIDDEN','私库请求超出已授权仓库');
  const token=await provider.scopedToken(integration.installationId,integration.repositoryId);
  const headers=new Headers(init?.headers);headers.set('authorization','Bearer '+token);return provider.transport(url,{...init,redirect:'error',headers});
 };
}

export async function privateSourceArchive(provider:GitHubApp,integration:{installationId:string;repositoryId:string;repository:string},sha:string){
 if(!/^[a-f0-9]{40}$/.test(sha))throw new ApiError('VALIDATION_ERROR','源码版本无效');
 const token=await provider.scopedToken(integration.installationId,integration.repositoryId);
 const response=await provider.transport(`https://api.github.com/repos/${integration.repository}/tarball/${sha}`,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,'user-agent':'aiqa-github-app'}});
 if(response.status!==302)throw new ApiError('DEPENDENCY_UNAVAILABLE','GitHub 源码归档不可用');
 const location=new URL(response.headers.get('location')??'https://invalid');
 if(location.origin!=='https://codeload.github.com'||location.search||location.username||location.password||![`/${integration.repository}/legacy.tar.gz/${sha}`,`/${integration.repository}/tar.gz/${sha}`].some(p=>p.toLowerCase()===location.pathname.toLowerCase()))throw new ApiError('FORBIDDEN','源码归档跳转超出当前仓库和版本');
 const archive=await provider.transport(location,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+token,'user-agent':'aiqa-github-app'}});
 if(!archive.ok)throw new ApiError('DEPENDENCY_UNAVAILABLE','私库归档下载失败');
 const reader=archive.body?.getReader();if(!reader)throw new ApiError('DEPENDENCY_UNAVAILABLE','归档为空');
 let bytes=0;const chunks:Uint8Array[]=[];try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>25*1024*1024)throw new ApiError('VALIDATION_ERROR','源码归档超过 25 MiB 支持范围');chunks.push(r.value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
