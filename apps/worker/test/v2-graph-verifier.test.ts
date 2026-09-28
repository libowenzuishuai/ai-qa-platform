import {it,expect} from 'vitest';
import type {OracleSpec,OracleAssertion} from '@ai-qa/contracts';
import {verifyGraphAssertions} from '../src/v2/graph-verifier.js';
const assertion={id:'a',ruleVersionId:'rule',kind:'deterministic',fact:'amount',observationType:'api_field',observationRef:'amount',operator:'equals',expected:'0.30',tolerance:'0.001',precondition:null,unit:null,allowedRoles:[],required:true} as OracleAssertion;
function check(actual:unknown,over:Partial<OracleAssertion>={}){return verifyGraphAssertions({assertions:[{...assertion,...over}]} as OracleSpec,{a:{nodeId:'verify',path:'actual'}},[{nodeId:'verify',status:'completed',attempts:1,output:{actual}}])[0]!;}
it('decimal tolerance is independent and exact; failed numeric parsing cannot make not_equals pass',()=>{
 expect(check(0.1+0.2).verdict).toBe('pass');expect(check('not a number',{operator:'not_equals'}).verdict).toBe('review');expect(check('9'.repeat(1000)).verdict).toBe('review');expect(check('0.31').verdict).toBe('fail');
});
it('absence is a fact only when the observation completed; hidden requires actual boolean',()=>{
 expect(check(undefined,{operator:'not_exists'}).verdict).toBe('pass');expect(check('false',{operator:'hidden'}).verdict).toBe('review');
 expect(verifyGraphAssertions({assertions:[assertion]} as OracleSpec,{a:{nodeId:'absent',path:'field'}},[])[0]!.verdict).toBe('review');
});
