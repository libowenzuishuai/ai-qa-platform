import {Ajv} from 'ajv';
import {createHash} from 'node:crypto';
import {ApiError} from './errors.js';
const ajv=new Ajv({strict:true,allErrors:false,coerceTypes:false,useDefaults:false,removeAdditional:false,validateFormats:true});
const cache=new Map<string,ReturnType<Ajv['compile']>>();
export function capabilityValidator(schema:unknown){
 if(!schema||typeof schema!=='object'||Array.isArray(schema)||JSON.stringify(schema).length>50000)throw new ApiError('VALIDATION_ERROR','能力 Schema 必须是有界 JSON 对象');
 const serialized=JSON.stringify(schema);if(serialized.includes('"$async"')||serialized.includes('"$data"'))throw new ApiError('VALIDATION_ERROR','不支持异步或动态 Schema');
 const key=createHash('sha256').update(serialized).digest('hex');const found=cache.get(key);if(found)return found;
 try{const validator=ajv.compile(schema);if(cache.size>=200)cache.delete(cache.keys().next().value!);cache.set(key,validator);return validator;}catch{throw new ApiError('VALIDATION_ERROR','能力 Schema 无效或包含无法解析的引用');}
}
export function assertCapabilityValue(schema:unknown,value:unknown){if(!capabilityValidator(schema)(value))throw new ApiError('VALIDATION_ERROR','能力输入或输出未通过固定版本 Schema 校验');}
export function assertCapabilityRole(required:string[],actual:string){const rank:Record<string,number>={VIEWER:0,LEAD:1,ADMIN:2};if(required.some(role=>rank[role]===undefined||(rank[actual]??-1)<rank[role]!))throw new ApiError('FORBIDDEN','当前项目角色不满足能力所需权限');}
